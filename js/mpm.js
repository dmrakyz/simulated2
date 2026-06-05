/**
 * MLS-MPM Physics Engine (Moving Least Squares Material Point Method)
 * Hu et al. 2018 — CPU implementation, fully self-contained, no external deps.
 *
 * Unified solver for:
 *   fluid     — weakly-compressible EOS, one-sided pressure (water, lava, honey, oil)
 *   granular  — fluid EOS w/ no tension + internal friction (sand, mud)
 *   elastic   — fixed-corotated (neo-Hookean-ish) via polar decomposition (rubber/ice/snow)
 *
 * IMPORTANT physical notes:
 *  - Each particle carries a REAL mass (p_vol * density), so dense materials
 *    generate more momentum and sink through lighter ones (buoyancy emerges).
 *  - Stiffness E is in physically-meaningful Pa-scale (~1e5..1e6). With explicit
 *    time integration this requires enough substeps to satisfy the CFL limit
 *    dt < dx / sqrt(E/rho). The engine uses 8 substeps/frame by default.
 *  - Collision/incompressibility is NOT particle-particle; it emerges from the
 *    grid: when particles crowd a cell, density rises (J<1), pressure builds, and
 *    the pressure gradient pushes them apart. Weak E => particles pancake. Correct
 *    E => stacks hold their shape and pool/pile realistically.
 *  - Damping is done by scaling the APIC affine matrix C (acts like viscosity /
 *    internal friction) — NOT by multiplying linear velocity, which would break
 *    free-fall and make heavy materials look like slow-motion.
 */

/* ── Material table ───────────────────────────────────────────────────
 *  rho    : density            (kg/m³)
 *  E      : Young's modulus / bulk stiffness (Pa, tuned for explicit stability)
 *  nu     : Poisson ratio      (elastic only)
 *  type   : 'fluid' | 'granular' | 'elastic'
 *  cScale : APIC C retention per substep (1 = inviscid, lower = viscous/sticky)
 *  vdamp  : linear velocity retention (near 1.0; only a gentle stabiliser)
 */
/* type codes: 0 = fluid, 1 = granular, 2 = elastic */
export const MATERIALS = [
  // id 0: Water — thin, inviscid, pools flat
  { name:'Water', col:0x2299ff, rho:1000, E:7.0e5, type:'fluid',    cScale:1.00, vdamp:1.000 },
  // id 1: Sand — granular, piles at an angle of repose
  { name:'Sand',  col:0xd9b25f, rho:1600, E:5.0e5, type:'granular', cScale:0.20, vdamp:0.998 },
  // id 2: Lava — dense, very viscous fluid
  { name:'Lava',  col:0xff5522, rho:3100, E:8.0e5, type:'fluid',    cScale:0.45, vdamp:0.992 },
  // id 3: Snow — light, soft elastic that compacts
  { name:'Snow',  col:0xeef3ff, rho:400,  E:1.2e5, nu:0.20, type:'elastic', cScale:1.00, vdamp:0.999 },
  // id 4: Honey — heavy, very viscous fluid (slow ribbons)
  { name:'Honey', col:0xffb022, rho:1400, E:6.0e5, type:'fluid',    cScale:0.30, vdamp:0.992 },
  // id 5: Mud — granular + sticky
  { name:'Mud',   col:0x7a5a38, rho:1800, E:4.0e5, type:'granular', cScale:0.28, vdamp:0.996 },
  // id 6: Oil — light, mildly viscous fluid
  { name:'Oil',   col:0x3c3a22, rho:900,  E:6.0e5, type:'fluid',    cScale:0.80, vdamp:0.997 },
  // id 7: Ice — stiff elastic, holds its shape and bounces
  // (E capped at 8e5 so the elastic wave speed stays CFL-stable at 5 substeps)
  { name:'Ice',   col:0xaadcff, rho:917,  E:8.0e5, nu:0.32, type:'elastic', cScale:1.00, vdamp:1.000 },
];

const TYPE_CODE = { fluid: 0, granular: 1, elastic: 2 };

/* Precompute Lamé parameters for elastic materials. */
for (const m of MATERIALS) {
  const nu = m.nu ?? 0.3;
  m._mu = m.E / (2 * (1 + nu));
  m._la = m.E * nu / ((1 + nu) * (1 - 2 * nu));
}

/* Module scratch for polar decomposition rotation factor R (row-major 3×3). */
const _R = new Float64Array(9);

/**
 * Polar decomposition F = R·S  →  writes the orthogonal factor R into _R.
 * Iterates  R ← ½(R + R^{-T})  (Higham's Newton iteration), which converges
 * quadratically for F near the identity (our small-strain regime).
 */
function polarR(F, o) {
  let r0=F[o],   r1=F[o+1], r2=F[o+2],
      r3=F[o+3], r4=F[o+4], r5=F[o+5],
      r6=F[o+6], r7=F[o+7], r8=F[o+8];

  for (let it = 0; it < 16; it++) {
    const det = r0*(r4*r8-r5*r7) - r1*(r3*r8-r5*r6) + r2*(r3*r7-r4*r6);
    if (Math.abs(det) < 1e-9) break;
    const id = 1.0 / det;

    // inverse of R (adjugate / det)
    const i0=(r4*r8-r5*r7)*id, i1=(r2*r7-r1*r8)*id, i2=(r1*r5-r2*r4)*id;
    const i3=(r5*r6-r3*r8)*id, i4=(r0*r8-r2*r6)*id, i5=(r2*r3-r0*r5)*id;
    const i6=(r3*r7-r4*r6)*id, i7=(r1*r6-r0*r7)*id, i8=(r0*r4-r1*r3)*id;

    // R^{-T} = transpose(inverse) ; average with R
    const n0=0.5*(r0+i0), n1=0.5*(r1+i3), n2=0.5*(r2+i6),
          n3=0.5*(r3+i1), n4=0.5*(r4+i4), n5=0.5*(r5+i7),
          n6=0.5*(r6+i2), n7=0.5*(r7+i5), n8=0.5*(r8+i8);

    const conv = Math.abs(n0-r0)+Math.abs(n4-r4)+Math.abs(n8-r8);
    r0=n0;r1=n1;r2=n2;r3=n3;r4=n4;r5=n5;r6=n6;r7=n7;r8=n8;
    if (conv < 1e-6) break;
  }
  _R[0]=r0;_R[1]=r1;_R[2]=r2;_R[3]=r3;_R[4]=r4;_R[5]=r5;_R[6]=r6;_R[7]=r7;_R[8]=r8;
}

export class MPM {
  /**
   * @param {object} opts
   * @param {number} opts.gridN       cells per axis (default 48)
   * @param {number} opts.dx          cell size in metres (default 0.25)
   * @param {number} opts.maxParticles
   * @param {number} opts.substeps    physics substeps per tick (>=8 recommended)
   */
  constructor(opts = {}) {
    this.N    = opts.gridN        || 48;
    this.DX   = opts.dx           || 0.25;
    this.MAX  = opts.maxParticles || 24000;
    this.sub  = opts.substeps     || 8;
    this.gravity = opts.gravity   ?? -9.8;

    this.INV  = 1 / this.DX;
    this.N3   = this.N * this.N * this.N;
    this.DOMAIN = this.N * this.DX;

    /* Per-particle reference volume: 2 particles/cell/axis → 8 per cell,
       each owns (dx/2)³. p_mass = PVOL * rho gives correct bulk density. */
    this.PVOL = (this.DX * 0.5) ** 3;
    this.DINV = 4.0 * this.INV * this.INV;   // quadratic B-spline D⁻¹

    /* particle buffers */
    const M = this.MAX;
    this.px  = new Float32Array(M);
    this.py  = new Float32Array(M);
    this.pz  = new Float32Array(M);
    this.pvx = new Float32Array(M);
    this.pvy = new Float32Array(M);
    this.pvz = new Float32Array(M);
    this.pC  = new Float32Array(M * 9);  // APIC affine velocity matrix
    this.pF  = new Float32Array(M * 9);  // deformation gradient (elastic)
    this.pJ  = new Float32Array(M);      // volume ratio (fluid/granular)
    this.pMt = new Uint8Array(M);
    this.nP  = 0;

    /* grid buffers (momentum stored first, converted to velocity in-place) */
    this.gM  = new Float32Array(this.N3);
    this.gVx = new Float32Array(this.N3);
    this.gVy = new Float32Array(this.N3);
    this.gVz = new Float32Array(this.N3);

    /* reusable weight arrays to avoid per-iteration GC */
    this._WX = new Float32Array(3);
    this._WY = new Float32Array(3);
    this._WZ = new Float32Array(3);

    /* Flatten material params into typed arrays indexed by material id.
       Reading these in the hot loop avoids object-property megamorphism
       and per-particle string comparisons (a big V8 speedup). */
    const NM = MATERIALS.length;
    this._mType = new Uint8Array(NM);   // 0 fluid / 1 granular / 2 elastic
    this._mMass = new Float64Array(NM); // PVOL * rho
    this._mE    = new Float64Array(NM);
    this._mMu   = new Float64Array(NM);
    this._mLa   = new Float64Array(NM);
    this._mCs   = new Float64Array(NM); // cScale
    this._mVd   = new Float64Array(NM); // vdamp
    for (let i = 0; i < NM; i++) {
      const m = MATERIALS[i];
      this._mType[i] = TYPE_CODE[m.type] ?? 0;
      this._mMass[i] = this.PVOL * m.rho;
      this._mE[i]    = m.E;
      this._mMu[i]   = m._mu;
      this._mLa[i]   = m._la;
      this._mCs[i]   = m.cScale;
      this._mVd[i]   = m.vdamp;
    }
  }

  /* ── Spawn helpers ──────────────────────────────────────── */

  /**
   * Spawn a filled axis-aligned box of particles.
   * ppc = particles per cell per axis (2 → matches PVOL mass calibration).
   */
  spawnBox(x0, y0, z0, x1, y1, z1, matId, ppc = 2) {
    const step = this.DX / ppc;
    const lo   = 1.5 * this.DX;
    const hi   = (this.N - 1.5) * this.DX;
    const jitter = step * 0.25;

    for (let x = x0; x < x1; x += step) {
      for (let y = y0; y < y1; y += step) {
        for (let z = z0; z < z1; z += step) {
          if (this.nP >= this.MAX) return;
          const i = this.nP;
          this.px[i] = Math.max(lo, Math.min(hi, x + (Math.random()-0.5)*jitter));
          this.py[i] = Math.max(lo, Math.min(hi, y + (Math.random()-0.5)*jitter));
          this.pz[i] = Math.max(lo, Math.min(hi, z + (Math.random()-0.5)*jitter));
          this.pvx[i] = 0; this.pvy[i] = 0; this.pvz[i] = 0;
          this.pJ[i]  = 1.0;
          this.pMt[i] = matId;
          const o = i * 9;
          for (let c = 0; c < 9; c++) this.pC[o+c] = 0;
          // F = identity
          this.pF[o]=1; this.pF[o+1]=0; this.pF[o+2]=0;
          this.pF[o+3]=0; this.pF[o+4]=1; this.pF[o+5]=0;
          this.pF[o+6]=0; this.pF[o+7]=0; this.pF[o+8]=1;
          this.nP++;
        }
      }
    }
  }

  /** Remove all particles */
  reset() { this.nP = 0; }

  /* ── Physics tick ──────────────────────────────────────── */

  tick() {
    const DT = 1 / 60 / this.sub;
    for (let s = 0; s < this.sub; s++) this._step(DT);
  }

  _step(DT) {
    const { N, INV, DX, PVOL, DINV,
            px, py, pz, pvx, pvy, pvz, pC, pF, pJ, pMt, nP,
            gM, gVx, gVy, gVz, _WX, _WY, _WZ,
            _mType, _mMass, _mE, _mMu, _mLa, _mCs, _mVd } = this;
    const coef = -DT * PVOL * DINV;

    /* ── RESET GRID ────────────────────────────────────────── */
    gM.fill(0); gVx.fill(0); gVy.fill(0); gVz.fill(0);

    /* ── P2G (particle → grid) ─────────────────────────────── */
    for (let p = 0; p < nP; p++) {
      const mt  = pMt[p];
      const type = _mType[mt];
      const pm  = _mMass[mt];              // real particle mass
      const fo  = p * 9;

      /* --- constitutive stress → affine matrix A = stressTerm + pm·C --- */
      let A0,A1,A2,A3,A4,A5,A6,A7,A8;
      const C0=pC[fo],   C1=pC[fo+1], C2=pC[fo+2];
      const C3=pC[fo+3], C4=pC[fo+4], C5=pC[fo+5];
      const C6=pC[fo+6], C7=pC[fo+7], C8=pC[fo+8];

      if (type === 2) { /* elastic */
        const f0=pF[fo],   f1=pF[fo+1], f2=pF[fo+2],
              f3=pF[fo+3],  f4=pF[fo+4], f5=pF[fo+5],
              f6=pF[fo+6],  f7=pF[fo+7], f8=pF[fo+8];
        const J = f0*(f4*f8-f5*f7) - f1*(f3*f8-f5*f6) + f2*(f3*f7-f4*f6);

        polarR(pF, fo);                    // → _R (rotation factor)
        // M = F − R
        const m0=f0-_R[0], m1=f1-_R[1], m2=f2-_R[2],
              m3=f3-_R[3], m4=f4-_R[4], m5=f5-_R[5],
              m6=f6-_R[6], m7=f7-_R[7], m8=f8-_R[8];
        // P = M · Fᵀ
        const p0=m0*f0+m1*f1+m2*f2, p1=m0*f3+m1*f4+m2*f5, p2=m0*f6+m1*f7+m2*f8;
        const p3=m3*f0+m4*f1+m5*f2, p4=m3*f3+m4*f4+m5*f5, p5=m3*f6+m4*f7+m5*f8;
        const p6=m6*f0+m7*f1+m8*f2, p7=m6*f3+m7*f4+m8*f5, p8=m6*f6+m7*f7+m8*f8;
        // Kirchhoff stress τ = 2μ·(F−R)Fᵀ + λ·J·(J−1)·I
        const mu2 = 2 * _mMu[mt];
        const lj  = _mLa[mt] * J * (J - 1.0);
        A0 = coef*(mu2*p0+lj) + pm*C0;  A1 = coef*(mu2*p1) + pm*C1;  A2 = coef*(mu2*p2) + pm*C2;
        A3 = coef*(mu2*p3)    + pm*C3;  A4 = coef*(mu2*p4+lj) + pm*C4; A5 = coef*(mu2*p5) + pm*C5;
        A6 = coef*(mu2*p6)    + pm*C6;  A7 = coef*(mu2*p7) + pm*C7;  A8 = coef*(mu2*p8+lj) + pm*C8;
      } else {
        /* fluid / granular: isotropic pressure from volume ratio J.
           One-sided: only compression (J<1) generates pressure — no tensile
           "stickiness" that would make particles attract like magnets. */
        const J = pJ[p];
        let press = _mE[mt] * (J - 1.0);
        if (press > 0) press = 0;          // no tension
        const s = coef * press;            // scalar stress term
        A0 = s + pm*C0;  A1 = pm*C1;     A2 = pm*C2;
        A3 = pm*C3;      A4 = s + pm*C4; A5 = pm*C5;
        A6 = pm*C6;      A7 = pm*C7;     A8 = s + pm*C8;
      }

      const xp = px[p], yp = py[p], zp = pz[p];
      const bx = (xp * INV - 0.5) | 0;
      const by = (yp * INV - 0.5) | 0;
      const bz = (zp * INV - 0.5) | 0;
      const fx = xp * INV - bx, fy = yp * INV - by, fz = zp * INV - bz;

      _WX[0]=0.5*(1.5-fx)*(1.5-fx); _WX[1]=0.75-(fx-1)*(fx-1); _WX[2]=0.5*(fx-0.5)*(fx-0.5);
      _WY[0]=0.5*(1.5-fy)*(1.5-fy); _WY[1]=0.75-(fy-1)*(fy-1); _WY[2]=0.5*(fy-0.5)*(fy-0.5);
      _WZ[0]=0.5*(1.5-fz)*(1.5-fz); _WZ[1]=0.75-(fz-1)*(fz-1); _WZ[2]=0.5*(fz-0.5)*(fz-0.5);

      const vx = pvx[p], vy = pvy[p], vz = pvz[p];
      const mvx = pm*vx, mvy = pm*vy, mvz = pm*vz;

      for (let i = 0; i < 3; i++) {
        const gi = bx + i; if (gi < 0 || gi >= N) continue;
        const dpx = (i - fx) * DX;
        for (let j = 0; j < 3; j++) {
          const gj = by + j; if (gj < 0 || gj >= N) continue;
          const dpy = (j - fy) * DX;
          const wij = _WX[i] * _WY[j];
          for (let k = 0; k < 3; k++) {
            const gk = bz + k; if (gk < 0 || gk >= N) continue;
            const dpz = (k - fz) * DX;
            const w   = wij * _WZ[k];
            const idx = (gi * N + gj) * N + gk;

            gM[idx]  += w * pm;
            gVx[idx] += w * (mvx + A0*dpx + A1*dpy + A2*dpz);
            gVy[idx] += w * (mvy + A3*dpx + A4*dpy + A5*dpz);
            gVz[idx] += w * (mvz + A6*dpx + A7*dpy + A8*dpz);
          }
        }
      }
    }

    /* ── GRID UPDATE (momentum → velocity, gravity, boundaries) ─── */
    const g = this.gravity;
    for (let idx = 0; idx < this.N3; idx++) {
      const mass = gM[idx];
      if (mass < 1e-12) continue;
      const im = 1.0 / mass;

      // decode cell coords (idx = (i*N + j)*N + k)
      const k = idx % N;
      const j = ((idx / N) | 0) % N;
      const i = (idx / (N * N)) | 0;

      let vx = gVx[idx] * im;
      let vy = gVy[idx] * im + DT * g;
      let vz = gVz[idx] * im;

      // walls: zero the inward normal component
      if (i < 2   && vx < 0) vx = 0;
      if (i > N-3 && vx > 0) vx = 0;
      if (j < 2   && vy < 0) vy = 0;
      if (j > N-3 && vy > 0) vy = 0;
      if (k < 2   && vz < 0) vz = 0;
      if (k > N-3 && vz > 0) vz = 0;

      // floor friction so granular material can build slopes / piles
      if (j < 2) { vx *= 0.90; vz *= 0.90; }

      gVx[idx] = vx; gVy[idx] = vy; gVz[idx] = vz;
    }

    /* ── G2P (grid → particle) + constitutive update + advect ─── */
    const lo = 1.5 * DX, hi = (N - 1.5) * DX;

    for (let p = 0; p < nP; p++) {
      const mt  = pMt[p];
      const type = _mType[mt];
      const fo  = p * 9;

      const xp = px[p], yp = py[p], zp = pz[p];
      const bx = (xp * INV - 0.5) | 0;
      const by = (yp * INV - 0.5) | 0;
      const bz = (zp * INV - 0.5) | 0;
      const fx = xp * INV - bx, fy = yp * INV - by, fz = zp * INV - bz;

      _WX[0]=0.5*(1.5-fx)*(1.5-fx); _WX[1]=0.75-(fx-1)*(fx-1); _WX[2]=0.5*(fx-0.5)*(fx-0.5);
      _WY[0]=0.5*(1.5-fy)*(1.5-fy); _WY[1]=0.75-(fy-1)*(fy-1); _WY[2]=0.5*(fy-0.5)*(fy-0.5);
      _WZ[0]=0.5*(1.5-fz)*(1.5-fz); _WZ[1]=0.75-(fz-1)*(fz-1); _WZ[2]=0.5*(fz-0.5)*(fz-0.5);

      let nvx=0, nvy=0, nvz=0;
      let C0=0,C1=0,C2=0,C3=0,C4=0,C5=0,C6=0,C7=0,C8=0;

      for (let i = 0; i < 3; i++) {
        const gi = bx + i; if (gi < 0 || gi >= N) continue;
        const dpx = (i - fx) * DX;
        for (let j = 0; j < 3; j++) {
          const gj = by + j; if (gj < 0 || gj >= N) continue;
          const dpy = (j - fy) * DX;
          const wij = _WX[i] * _WY[j];
          for (let k = 0; k < 3; k++) {
            const gk = bz + k; if (gk < 0 || gk >= N) continue;
            const dpz = (k - fz) * DX;
            const w   = wij * _WZ[k];
            const idx = (gi * N + gj) * N + gk;
            const gvx = gVx[idx], gvy = gVy[idx], gvz = gVz[idx];

            nvx += w*gvx; nvy += w*gvy; nvz += w*gvz;
            const sc = w * DINV;          // C += D⁻¹ · w · v ⊗ dpos
            C0 += sc*gvx*dpx; C1 += sc*gvx*dpy; C2 += sc*gvx*dpz;
            C3 += sc*gvy*dpx; C4 += sc*gvy*dpy; C5 += sc*gvy*dpz;
            C6 += sc*gvz*dpx; C7 += sc*gvz*dpy; C8 += sc*gvz*dpz;
          }
        }
      }

      /* velocity (PIC) with a gentle per-material stabiliser */
      const vd = _mVd[mt];
      pvx[p] = nvx * vd; pvy[p] = nvy * vd; pvz[p] = nvz * vd;

      /* viscosity / internal friction: scale the affine matrix.
         (Reducing C, NOT linear velocity, so materials still fall at g.) */
      const cs = _mCs[mt];
      C0*=cs;C1*=cs;C2*=cs;C3*=cs;C4*=cs;C5*=cs;C6*=cs;C7*=cs;C8*=cs;
      pC[fo]=C0;pC[fo+1]=C1;pC[fo+2]=C2;
      pC[fo+3]=C3;pC[fo+4]=C4;pC[fo+5]=C5;
      pC[fo+6]=C6;pC[fo+7]=C7;pC[fo+8]=C8;

      /* ── deformation update ── */
      if (type === 2) { /* elastic */
        // F ← (I + dt·C) · F
        const a0=1+DT*C0, a1=DT*C1,   a2=DT*C2;
        const a3=DT*C3,   a4=1+DT*C4, a5=DT*C5;
        const a6=DT*C6,   a7=DT*C7,   a8=1+DT*C8;
        const f0=pF[fo],   f1=pF[fo+1], f2=pF[fo+2],
              f3=pF[fo+3],  f4=pF[fo+4], f5=pF[fo+5],
              f6=pF[fo+6],  f7=pF[fo+7], f8=pF[fo+8];
        pF[fo]   = a0*f0+a1*f3+a2*f6; pF[fo+1] = a0*f1+a1*f4+a2*f7; pF[fo+2] = a0*f2+a1*f5+a2*f8;
        pF[fo+3] = a3*f0+a4*f3+a5*f6; pF[fo+4] = a3*f1+a4*f4+a5*f7; pF[fo+5] = a3*f2+a4*f5+a5*f8;
        pF[fo+6] = a6*f0+a7*f3+a8*f6; pF[fo+7] = a6*f1+a7*f4+a8*f7; pF[fo+8] = a6*f2+a7*f5+a8*f8;
      } else {
        // J ← J·(1 + dt·tr(C))
        let J = pJ[p] * (1.0 + DT * (C0 + C4 + C8));
        if (type === 1 && J > 1.0) J = 1.0;  // granular: no stored expansion
        pJ[p] = J < 0.6 ? 0.6 : J > 1.5 ? 1.5 : J;
      }

      /* advect */
      let npx = xp + DT*nvx, npy = yp + DT*nvy, npz = zp + DT*nvz;
      px[p] = npx < lo ? lo : npx > hi ? hi : npx;
      py[p] = npy < lo ? lo : npy > hi ? hi : npy;
      pz[p] = npz < lo ? lo : npz > hi ? hi : npz;
    }
  }
}
