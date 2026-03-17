/* ============================================================
   PID Tuner – simulation engine, math parser, optimizer, plots
   ============================================================ */

(function () {
  'use strict';

  // ── Theme toggle (shared with main site) ──────────────────
  const toggle = document.getElementById('themeToggle');
  const html = document.documentElement;
  toggle.addEventListener('click', () => {
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    drawAll();
  });

  // ── Nav scroll shadow ─────────────────────────────────────
  const nav = document.getElementById('navbar');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  });

  /* ==========================================================
     MATH PARSER – recursive descent, no eval()
     ========================================================== */
  function parseMath(expr) {
    const tokens = tokenize(expr);
    if (!tokens || tokens.length === 0) return null;
    let pos = 0;

    function peek() { return pos < tokens.length ? tokens[pos] : null; }
    function consume() { return tokens[pos++]; }

    function parseExpr() { return parseAdd(); }

    function parseAdd() {
      let left = parseMul();
      while (peek() === '+' || peek() === '-') {
        const op = consume();
        const right = parseMul();
        const l = left, r = right;
        left = op === '+' ? (t => l(t) + r(t)) : (t => l(t) - r(t));
      }
      return left;
    }

    function parseMul() {
      let left = parsePow();
      while (peek() === '*' || peek() === '/') {
        const op = consume();
        const right = parsePow();
        const l = left, r = right;
        left = op === '*' ? (t => l(t) * r(t)) : (t => l(t) / r(t));
      }
      return left;
    }

    function parsePow() {
      let base = parseUnary();
      if (peek() === '^') {
        consume();
        const exp = parsePow();
        const b = base;
        base = (t => Math.pow(b(t), exp(t)));
      }
      return base;
    }

    function parseUnary() {
      if (peek() === '-') {
        consume();
        const operand = parseUnary();
        return (t => -operand(t));
      }
      if (peek() === '+') { consume(); return parseUnary(); }
      return parseAtom();
    }

    function parseAtom() {
      const tok = peek();
      if (tok === '(') {
        consume();
        const inner = parseExpr();
        if (peek() !== ')') throw new Error('Missing )');
        consume();
        return inner;
      }
      if (tok === 't') { consume(); return (t => t); }
      if (tok === 'pi') { consume(); return () => Math.PI; }
      if (typeof tok === 'number') { consume(); const v = tok; return () => v; }

      // Functions
      const fns = { sin: Math.sin, cos: Math.cos, exp: Math.exp, abs: Math.abs, sqrt: Math.sqrt };
      if (fns[tok]) {
        consume();
        if (peek() !== '(') throw new Error(tok + ' requires ()');
        consume();
        const arg = parseExpr();
        if (peek() !== ')') throw new Error('Missing )');
        consume();
        const fn = fns[tok];
        return (t => fn(arg(t)));
      }
      if (tok === 'pow') {
        consume();
        if (peek() !== '(') throw new Error('pow requires ()');
        consume();
        const base = parseExpr();
        if (peek() !== ',') throw new Error('pow requires two args');
        consume();
        const exp = parseExpr();
        if (peek() !== ')') throw new Error('Missing )');
        consume();
        return (t => Math.pow(base(t), exp(t)));
      }
      if (tok === 'step') {
        consume();
        if (peek() === '(') {
          consume();
          const arg = parseExpr();
          if (peek() !== ')') throw new Error('Missing )');
          consume();
          return (t => arg(t) >= 0 ? 1 : 0);
        }
        return (t => t >= 0 ? 1 : 0);
      }
      throw new Error('Unexpected: ' + tok);
    }

    try {
      const fn = parseExpr();
      if (pos < tokens.length) throw new Error('Unexpected token');
      // Test evaluation
      fn(0); fn(1);
      return fn;
    } catch (e) {
      return null;
    }
  }

  function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const s = expr.replace(/\s+/g, '');
    while (i < s.length) {
      const ch = s[i];
      if ('+-*/^(),'.includes(ch)) { tokens.push(ch); i++; continue; }
      if (ch >= '0' && ch <= '9' || ch === '.') {
        let num = '';
        while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) num += s[i++];
        tokens.push(parseFloat(num));
        if (isNaN(tokens[tokens.length - 1])) return null;
        continue;
      }
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
        let word = '';
        while (i < s.length && ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z'))) word += s[i++];
        tokens.push(word);
        continue;
      }
      return null;
    }
    return tokens;
  }

  /* ==========================================================
     STATE
     ========================================================== */
  const state = {
    kp: 1, ki: 0, kd: 0,
    wn: 1, zeta: 0.5,
    duration: 10,
    dt: 0.005,
    measNoise: false, measAmp: 0.5,
    procNoise: false, procAmp: 0.5,
    noiseSeed: 42,
    refMode: 'single',
    refFn: () => 5,
    playing: false,
    playTime: 0,
    simData: null,
    animFrame: null,
    lastFrameTime: 0,
  };

  // Seeded PRNG (xorshift32)
  function makeRng(seed) {
    let s = seed | 0 || 1;
    return function () {
      s ^= s << 13; s ^= s >> 17; s ^= s << 5;
      return (s >>> 0) / 4294967296 * 2 - 1; // uniform [-1, 1]
    };
  }

  /* ==========================================================
     SIMULATION
     ========================================================== */
  function simulate(kp, ki, kd) {
    const { wn, zeta, duration, dt, measNoise, measAmp, procNoise, procAmp, noiseSeed, refFn } = state;
    const N = Math.ceil(duration / dt) + 1;
    const time = new Float64Array(N);
    const ref = new Float64Array(N);
    const output = new Float64Array(N);
    const control = new Float64Array(N);
    const pTerm = new Float64Array(N);
    const iTerm = new Float64Array(N);
    const dTerm = new Float64Array(N);

    const rng = makeRng(noiseSeed);
    const wn2 = wn * wn;
    const twozwn = 2 * zeta * wn;

    // State: [x1 (output), x2 (derivative)]
    let x1 = 0, x2 = 0;
    let integral = 0;
    let prevMeas = 0;
    const antiWindup = 100;

    for (let i = 0; i < N; i++) {
      const t = i * dt;
      time[i] = t;

      let r;
      try { r = refFn(t); } catch (e) { r = 0; }
      if (!isFinite(r)) r = 0;
      ref[i] = r;

      // Measurement with noise
      let meas = x1;
      if (measNoise) meas += measAmp * rng();

      // Error
      const e = r - meas;

      // PID
      const P = kp * e;
      integral += ki * e * dt;
      integral = Math.max(-antiWindup, Math.min(antiWindup, integral));
      const I = integral;
      const D = i === 0 ? 0 : -kd * (meas - prevMeas) / dt; // derivative on measurement, skip first sample
      prevMeas = meas;

      const u = P + I + D;

      pTerm[i] = P;
      iTerm[i] = I;
      dTerm[i] = D;
      control[i] = u;
      output[i] = x1;

      // Process noise
      let pn = 0;
      if (procNoise) pn = procAmp * rng();

      // RK4 integration of x1' = x2, x2' = -2*zeta*wn*x2 - wn^2*x1 + wn^2*(u + pn)
      const f = (s1, s2, uv) => [s2, -twozwn * s2 - wn2 * s1 + wn2 * uv];

      const uv = u + pn;
      const [k1a, k1b] = f(x1, x2, uv);
      const [k2a, k2b] = f(x1 + 0.5 * dt * k1a, x2 + 0.5 * dt * k1b, uv);
      const [k3a, k3b] = f(x1 + 0.5 * dt * k2a, x2 + 0.5 * dt * k2b, uv);
      const [k4a, k4b] = f(x1 + dt * k3a, x2 + dt * k3b, uv);

      x1 += dt / 6 * (k1a + 2 * k2a + 2 * k3a + k4a);
      x2 += dt / 6 * (k1b + 2 * k2b + 2 * k3b + k4b);

      // Early exit on instability
      if (!isFinite(x1) || Math.abs(x1) > 1e8) {
        for (let j = i + 1; j < N; j++) {
          time[j] = j * dt; ref[j] = ref[i];
          output[j] = NaN; control[j] = NaN;
          pTerm[j] = NaN; iTerm[j] = NaN; dTerm[j] = NaN;
        }
        break;
      }
    }

    return { time, ref, output, control, pTerm, iTerm, dTerm, N, dt };
  }

  function computeMetrics(data) {
    const { ref, output, time, N, dt } = data;
    // Use the final reference value as the target for step-like signals
    const target = ref[N - 1];
    const initial = output[0];
    const range = target - initial;

    let overshoot = 0, riseTime = NaN, settleTime = NaN;
    let ssError = Math.abs(target - output[N - 1]);

    if (Math.abs(range) > 1e-9) {
      // Overshoot — only count if output exceeds target in the step direction
      let peak = initial;
      for (let i = 0; i < N; i++) {
        if (isFinite(output[i])) {
          if (range > 0 && output[i] > peak) peak = output[i];
          if (range < 0 && output[i] < peak) peak = output[i];
        }
      }
      const exceeds = (range > 0 && peak > target) || (range < 0 && peak < target);
      overshoot = exceeds ? Math.abs((peak - target) / range) * 100 : 0;

      // Rise time (10% to 90%)
      const lo = initial + 0.1 * range;
      const hi = initial + 0.9 * range;
      let tLo = NaN, tHi = NaN;
      for (let i = 1; i < N; i++) {
        if (isNaN(tLo) && ((range > 0 && output[i] >= lo) || (range < 0 && output[i] <= lo))) tLo = time[i];
        if (isNaN(tHi) && ((range > 0 && output[i] >= hi) || (range < 0 && output[i] <= hi))) tHi = time[i];
      }
      riseTime = tHi - tLo;

      // Settling time (2% band)
      const band = 0.02 * Math.abs(range);
      settleTime = 0;
      for (let i = N - 1; i >= 0; i--) {
        if (Math.abs(output[i] - target) > band) { settleTime = time[i]; break; }
      }
    }

    // Cost function
    const costFnSel = document.getElementById('costFn').value;
    let cost = 0;
    for (let i = 0; i < N; i++) {
      const e = Math.abs(ref[i] - output[i]);
      if (costFnSel === 'ISE') cost += e * e * dt;
      else if (costFnSel === 'IAE') cost += e * dt;
      else cost += time[i] * e * dt; // ITAE
    }

    return { overshoot, riseTime, settleTime, ssError, cost };
  }

  /* ==========================================================
     OPTIMIZATION
     ========================================================== */
  function zieglerNichols() {
    // Ziegler-Nichols ultimate gain method:
    // 1. Increase Kp (with Ki=Kd=0) until sustained oscillation at the stability boundary
    // 2. Record ultimate gain Ku and ultimate period Tu
    // 3. Apply Z-N PID table: Kp = 0.6*Ku, Ti = Tu/2, Td = Tu/8
    //    In parallel form: Ki = Kp/Ti = 1.2*Ku/Tu, Kd = Kp*Td = 0.075*Ku*Tu

    const { wn, zeta } = state;
    let ku = 0, tu = 0;
    let prevKp = 0;

    // Binary search for marginal stability is more robust than linear sweep
    let lo = 0, hi = 500;

    // Helper: check if a given Kp produces sustained oscillation
    function checkOscillation(testKp) {
      const data = simulate(testKp, 0, 0);
      // Look at the last 60% of simulation for steady-state oscillation
      const startIdx = Math.floor(data.N * 0.4);

      // Check for instability first
      for (let i = 0; i < data.N; i++) {
        if (!isFinite(data.output[i]) || Math.abs(data.output[i]) > 1e8) return { status: 'unstable' };
      }

      // Count zero crossings of error in the latter portion
      let crossings = 0;
      let prevE = data.ref[startIdx] - data.output[startIdx];
      const crossTimes = [];
      for (let i = startIdx + 1; i < data.N; i++) {
        const e = data.ref[i] - data.output[i];
        if (prevE * e < 0) { crossings++; crossTimes.push(data.time[i]); }
        prevE = e;
      }

      // Check if oscillation amplitude is sustained (not decaying)
      if (crossings >= 6) {
        // Measure peak-to-peak in the last quarter
        const q3 = Math.floor(data.N * 0.75);
        let ampLate = 0;
        for (let i = q3; i < data.N; i++) {
          ampLate = Math.max(ampLate, Math.abs(data.ref[i] - data.output[i]));
        }
        // Measure peak-to-peak in the middle
        const q1 = Math.floor(data.N * 0.4);
        const q2 = Math.floor(data.N * 0.6);
        let ampEarly = 0;
        for (let i = q1; i < q2; i++) {
          ampEarly = Math.max(ampEarly, Math.abs(data.ref[i] - data.output[i]));
        }

        // Sustained if late amplitude is at least 80% of early amplitude
        if (ampEarly > 1e-6 && ampLate / ampEarly > 0.8) {
          // Compute period from zero crossings (every 2 crossings = 1 period)
          const periods = [];
          for (let j = 2; j < crossTimes.length; j += 2) {
            periods.push(crossTimes[j] - crossTimes[j - 2]);
          }
          const period = periods.length > 0 ? periods.reduce((a, b) => a + b) / periods.length : 0;
          return { status: 'oscillating', period };
        }
        return { status: 'decaying' };
      }

      return { status: crossings > 2 ? 'decaying' : 'stable' };
    }

    // Linear scan with adaptive step to find the critical Kp region
    for (let testKp = 0.5; testKp <= 500; testKp *= 1.15) {
      const result = checkOscillation(testKp);
      if (result.status === 'oscillating') {
        ku = testKp;
        tu = result.period;
        break;
      }
      if (result.status === 'unstable') {
        // Binary search between prevKp and testKp for the boundary
        lo = prevKp;
        hi = testKp;
        for (let iter = 0; iter < 20; iter++) {
          const mid = (lo + hi) / 2;
          const r = checkOscillation(mid);
          if (r.status === 'oscillating') { ku = mid; tu = r.period; break; }
          else if (r.status === 'unstable') { hi = mid; }
          else { lo = mid; }
        }
        // If we didn't find oscillation, use the boundary
        if (ku === 0) {
          ku = (lo + hi) / 2;
          // Estimate Tu from plant natural frequency
          tu = 2 * Math.PI / (wn * Math.sqrt(1 - zeta * zeta + 0.001));
        }
        break;
      }
      prevKp = testKp;
    }

    if (ku > 0 && tu > 0) {
      // Z-N PID formulas (parallel form):
      // Kp = 0.6 * Ku
      // Ti = Tu / 2  →  Ki = Kp / Ti = 1.2 * Ku / Tu
      // Td = Tu / 8  →  Kd = Kp * Td = 0.075 * Ku * Tu
      return {
        kp: 0.6 * ku,
        ki: 1.2 * ku / tu,
        kd: 0.075 * ku * tu,
        ku, tu
      };
    }
    return null;
  }

  function lambdaTuning(lambda) {
    // Lambda tuning (IMC-based) for a second-order plant:
    // Plant: G(s) = wn^2 / (s^2 + 2*zeta*wn*s + wn^2)
    //
    // Rewrite plant as G(s) = 1 / (tau1*s + 1)(tau2*s + 1)
    // where tau1, tau2 are the two time constants from the characteristic roots.
    //
    // For the second-order plant, the characteristic equation is:
    //   s^2 + 2*zeta*wn*s + wn^2 = 0
    //   roots: s = -zeta*wn ± wn*sqrt(zeta^2 - 1)
    //
    // Case 1: Overdamped (zeta >= 1) — two real poles
    //   tau1 = 1 / (zeta*wn - wn*sqrt(zeta^2 - 1))
    //   tau2 = 1 / (zeta*wn + wn*sqrt(zeta^2 - 1))
    //   IMC-PID: Kp = (tau1 + tau2) / lambda
    //            Ki = 1 / (lambda)  [from Ti = tau1 + tau2, Ki = Kp/Ti = 1/lambda... see below]
    //            Kd = (tau1 * tau2) / lambda
    //
    // Case 2: Underdamped (zeta < 1) — complex conjugate poles
    //   Treat as equivalent time constants from the real part:
    //   tau_eq = 1 / (zeta * wn)   (dominant time constant)
    //
    // General IMC formula for second-order plant (no time delay):
    //   C(s) = (tau1*s + 1)(tau2*s + 1) / (lambda*s)  [PI form for zero-free plant]
    //
    // This gives PID gains:
    //   Kp = (tau1 + tau2) / lambda
    //   Ti = tau1 + tau2             → Ki = Kp / Ti = 1 / lambda
    //   Td = (tau1 * tau2) / (tau1 + tau2)  → Kd = Kp * Td = (tau1*tau2) / lambda

    const { wn, zeta } = state;

    let tau1, tau2;

    if (zeta >= 1) {
      // Overdamped: two real distinct poles
      const disc = Math.sqrt(zeta * zeta - 1);
      tau1 = 1 / (wn * (zeta - disc));
      tau2 = 1 / (wn * (zeta + disc));
    } else {
      // Underdamped: complex poles — use Vieta's formulas
      // s^2 + 2*zeta*wn*s + wn^2 = 0 → sum of roots = 2*zeta*wn, product = wn^2
      // Equivalent time constant sum = 2*zeta/wn, product = 1/wn^2
      const tauSum = 2 * zeta / wn;
      const tauProd = 1 / (wn * wn);
      const kp = tauSum / lambda;
      const ki = 1 / lambda;
      const kd = tauProd / lambda;
      return { kp, ki, kd, tauSum, tauProd, lambda };
    }

    const tauSum = tau1 + tau2;
    const tauProd = tau1 * tau2;
    const kp = tauSum / lambda;
    const ki = 1 / lambda;
    const kd = tauProd / lambda;

    return { kp, ki, kd, tauSum, tauProd, lambda };
  }

  /* ==========================================================
     PIECEWISE REFERENCE
     ========================================================== */
  function buildPiecewiseRef() {
    const container = document.getElementById('piecewiseSegments');
    const segments = container.querySelectorAll('.pw-segment');
    const errorEl = document.getElementById('piecewiseError');
    const pieces = [];

    for (const seg of segments) {
      const loInput = seg.querySelector('.pw-lo');
      const hiInput = seg.querySelector('.pw-hi');
      const exprInput = seg.querySelector('.pw-expr');
      const lo = parseFloat(loInput.value);
      const hi = parseFloat(hiInput.value);
      const fn = parseMath(exprInput.value);

      loInput.classList.toggle('invalid', isNaN(lo));
      hiInput.classList.toggle('invalid', isNaN(hi) || hi <= lo);
      exprInput.classList.toggle('invalid', !fn);

      if (isNaN(lo) || isNaN(hi) || hi <= lo || !fn) {
        errorEl.textContent = 'Fix highlighted fields — bounds must increase, expressions must be valid.';
        errorEl.classList.remove('hidden');
        return null;
      }
      pieces.push({ lo, hi, fn });
    }

    if (pieces.length === 0) {
      errorEl.textContent = 'Add at least one segment.';
      errorEl.classList.remove('hidden');
      return null;
    }

    // Check coverage: segments must be contiguous
    pieces.sort((a, b) => a.lo - b.lo);
    for (let i = 1; i < pieces.length; i++) {
      if (Math.abs(pieces[i].lo - pieces[i - 1].hi) > 1e-9) {
        errorEl.textContent = `Gap between segments at t = ${pieces[i - 1].hi}. Segments must be contiguous.`;
        errorEl.classList.remove('hidden');
        return null;
      }
    }

    // Update duration from piecewise bounds
    const totalEnd = pieces[pieces.length - 1].hi;
    if (totalEnd > 0 && isFinite(totalEnd)) {
      state.duration = totalEnd;
      state.playTime = Math.min(state.playTime, state.duration);
    }

    errorEl.classList.add('hidden');

    return function (t) {
      for (const p of pieces) {
        if (t >= p.lo && t < p.hi) return p.fn(t);
      }
      // At or beyond last segment, use last
      return pieces[pieces.length - 1].fn(t);
    };
  }

  function addPiecewiseSegment(lo, hi, expr) {
    const container = document.getElementById('piecewiseSegments');
    const div = document.createElement('div');
    div.className = 'pw-segment';
    div.innerHTML = `
      <span class="pw-label">t &isin; [</span>
      <input type="text" class="pw-bound pw-lo" value="${lo}">
      <span class="pw-label">,</span>
      <input type="text" class="pw-bound pw-hi" value="${hi}">
      <span class="pw-label">]</span>
      <input type="text" class="pw-expr" value="${expr}" spellcheck="false" autocomplete="off">
      <button class="pw-remove" title="Remove segment">&times;</button>
    `;
    container.appendChild(div);

    div.querySelector('.pw-remove').addEventListener('click', () => {
      div.remove();
      onRefChange();
    });

    div.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', onRefChange);
    });
  }

  /* ==========================================================
     PLOTTING (Canvas)
     ========================================================== */
  function getPlotColors() {
    const isDark = html.getAttribute('data-theme') === 'dark';
    return {
      bg: isDark ? '#2a2926' : '#ffffff',
      grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      axis: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
      text: isDark ? '#928d82' : '#6b6660',
      ref: isDark ? '#5a9e8f' : '#3d7a6d',
      response: isDark ? '#e2dfd8' : '#262420',
      control: isDark ? '#d4a55a' : '#b8862d',
      pColor: '#5a9e8f',
      iColor: '#d4a55a',
      dColor: '#c0392b',
    };
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: rect.height };
  }

  function drawPlot(canvas, datasets, opts = {}) {
    const { ctx, w, h } = setupCanvas(canvas);
    const colors = getPlotColors();
    const pad = { left: 50, right: 15, top: 10, bottom: 22 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    if (!state.simData) return;

    const maxIdx = opts.maxIdx != null ? opts.maxIdx : state.simData.N - 1;
    const tMax = state.simData.time[state.simData.N - 1];

    // Compute Y range with sensible bounds
    let yMin = Infinity, yMax = -Infinity;
    for (const ds of datasets) {
      for (let i = 0; i <= maxIdx && i < ds.data.length; i++) {
        const v = ds.data[i];
        if (isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); }
      }
    }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    // Always include zero in range for context
    if (yMin > 0 && yMax > 0) yMin = 0;
    if (yMin < 0 && yMax < 0) yMax = 0;
    // Add symmetric padding (15% of range, minimum ±0.5)
    const rawRange = yMax - yMin || 1;
    const padding = Math.max(rawRange * 0.15, 0.5);
    yMin -= padding;
    yMax += padding;
    // Snap to nice round numbers
    function niceNum(val, ceil) {
      const exp = Math.floor(Math.log10(Math.abs(val) || 1));
      const frac = val / Math.pow(10, exp);
      const niced = ceil
        ? (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10)
        : (frac >= 5 ? 5 : frac >= 2 ? 2 : frac >= 1 ? 1 : 0.5);
      return niced * Math.pow(10, exp);
    }
    const tickSpacing = niceNum((yMax - yMin) / 5, false);
    yMin = Math.floor(yMin / tickSpacing) * tickSpacing;
    yMax = Math.ceil(yMax / tickSpacing) * tickSpacing;

    const toX = (t) => pad.left + (t / tMax) * pw;
    const toY = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ph;

    // Grid lines and Y-axis labels using tickSpacing for round numbers
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = colors.text;
    ctx.font = '10px Karla, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const decimals = tickSpacing >= 1 ? 0 : tickSpacing >= 0.1 ? 1 : 2;
    for (let val = yMin; val <= yMax + tickSpacing * 0.01; val += tickSpacing) {
      const y = toY(val);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = colors.text;
      ctx.fillText(val.toFixed(decimals), pad.left - 5, y);
    }

    // Zero line (thicker)
    if (yMin < 0 && yMax > 0) {
      ctx.strokeStyle = colors.axis;
      ctx.lineWidth = 1;
      const y0 = toY(0);
      ctx.beginPath(); ctx.moveTo(pad.left, y0); ctx.lineTo(w - pad.right, y0); ctx.stroke();
    }

    // Time axis labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const nGridX = 5;
    for (let i = 0; i <= nGridX; i++) {
      const t = (i / nGridX) * tMax;
      ctx.fillText(t.toFixed(1), toX(t), h - pad.bottom + 5);
    }

    // Data lines
    for (const ds of datasets) {
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = ds.lineWidth || 1.5;
      ctx.setLineDash(ds.dash || []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= maxIdx && i < ds.data.length; i++) {
        const v = ds.data[i];
        if (!isFinite(v)) { started = false; continue; }
        const x = toX(state.simData.time[i]);
        const y = toY(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Playhead line
    if (maxIdx < state.simData.N - 1) {
      const px = toX(state.simData.time[maxIdx]);
      ctx.strokeStyle = colors.ref;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.moveTo(px, pad.top); ctx.lineTo(px, h - pad.bottom); ctx.stroke();
      ctx.globalAlpha = 1;
    }

  }

  function buildHtmlLegend(el, items) {
    el.innerHTML = items.map(item =>
      item.dashed
        ? `<span class="legend-item"><span class="legend-line dashed" style="--color:${item.color}"></span>${item.label}</span>`
        : `<span class="legend-item"><span class="legend-line" style="background:${item.color}"></span>${item.label}</span>`
    ).join('');
  }

  function drawAll() {
    if (!state.simData) return;
    const colors = getPlotColors();
    const maxIdx = timeToIndex(state.playTime);

    drawPlot(document.getElementById('responsePlot'), [
      { data: state.simData.ref, color: colors.ref, dash: [6, 3], lineWidth: 1.5 },
      { data: state.simData.output, color: colors.response, lineWidth: 2 },
    ], { maxIdx });

    drawPlot(document.getElementById('controlPlot'), [
      { data: state.simData.control, color: colors.control, lineWidth: 1.5 },
    ], { maxIdx });

    drawPlot(document.getElementById('pidPlot'), [
      { data: state.simData.pTerm, color: colors.pColor, lineWidth: 1.5 },
      { data: state.simData.iTerm, color: colors.iColor, lineWidth: 1.5 },
      { data: state.simData.dTerm, color: colors.dColor, lineWidth: 1.5 },
    ], { maxIdx });

    // Update HTML legends
    buildHtmlLegend(document.getElementById('responseLegend'), [
      { label: 'Reference', color: colors.ref, dashed: true },
      { label: 'Response', color: colors.response },
    ]);
    buildHtmlLegend(document.getElementById('pidLegend'), [
      { label: 'P', color: colors.pColor },
      { label: 'I', color: colors.iColor },
      { label: 'D', color: colors.dColor },
    ]);
  }

  function timeToIndex(t) {
    return Math.min(state.simData.N - 1, Math.max(0, Math.round(t / state.dt)));
  }

  /* ==========================================================
     METRICS DISPLAY
     ========================================================== */
  function updateMetrics() {
    if (!state.simData) return;
    const m = computeMetrics(state.simData);
    const fmt = (v, suffix) => isFinite(v) ? v.toFixed(suffix === '%' ? 1 : suffix === 's' ? 3 : 4) + suffix : 'Unstable';
    document.getElementById('metricOvershoot').textContent = fmt(m.overshoot, '%');
    document.getElementById('metricRise').textContent = isFinite(m.riseTime) ? m.riseTime.toFixed(3) + 's' : '—';
    document.getElementById('metricSettle').textContent = m.settleTime > 0 ? m.settleTime.toFixed(3) + 's' : '—';
    document.getElementById('metricSSE').textContent = fmt(m.ssError, '');
    document.getElementById('metricCost').textContent = fmt(m.cost, '');
    document.getElementById('costLabel').textContent = document.getElementById('costFn').value;
  }

  /* ==========================================================
     TIMELINE & PLAYBACK
     ========================================================== */
  function updateTimeline() {
    const frac = state.playTime / state.duration;
    document.getElementById('timelineFill').style.width = (frac * 100) + '%';
    document.getElementById('timelineHead').style.left = (frac * 100) + '%';
    document.getElementById('timeDisplay').textContent =
      state.playTime.toFixed(2) + ' / ' + state.duration.toFixed(2) + ' s';
  }

  function startPlayback() {
    state.playing = true;
    document.getElementById('playPauseBtn').innerHTML = '<div class="pause-icon"><span></span><span></span></div>';
    state.lastFrameTime = performance.now();
    if (state.playTime >= state.duration) state.playTime = 0;
    tick();
  }

  function stopPlayback() {
    state.playing = false;
    document.getElementById('playPauseBtn').innerHTML = '<div class="play-icon"></div>';
    if (state.animFrame) { cancelAnimationFrame(state.animFrame); state.animFrame = null; }
  }

  function tick() {
    if (!state.playing) return;
    const now = performance.now();
    const elapsed = (now - state.lastFrameTime) / 1000;
    state.lastFrameTime = now;
    state.playTime = Math.min(state.duration, state.playTime + elapsed);

    updateTimeline();
    drawAll();

    if (state.playTime >= state.duration) {
      stopPlayback();
      return;
    }
    state.animFrame = requestAnimationFrame(tick);
  }

  // Timeline dragging
  function initTimelineDrag() {
    const track = document.getElementById('timelineTrack');
    const head = document.getElementById('timelineHead');
    let dragging = false;

    function setTimeFromMouse(e) {
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      state.playTime = frac * state.duration;
      updateTimeline();
      drawAll();
    }

    head.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
    track.addEventListener('mousedown', (e) => { dragging = true; setTimeFromMouse(e); });
    window.addEventListener('mousemove', (e) => { if (dragging) { setTimeFromMouse(e); } });
    window.addEventListener('mouseup', () => { dragging = false; });

    // Touch
    head.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault(); });
    track.addEventListener('touchstart', (e) => {
      dragging = true;
      setTimeFromMouse(e.touches[0]);
    });
    window.addEventListener('touchmove', (e) => { if (dragging) setTimeFromMouse(e.touches[0]); });
    window.addEventListener('touchend', () => { dragging = false; });
  }

  /* ==========================================================
     UPDATE LOOP — re-simulate on parameter change
     ========================================================== */
  function runSim() {
    state.simData = simulate(state.kp, state.ki, state.kd);
    drawAll();
    updateMetrics();
    updateTimeline();
  }

  function setGains(kp, ki, kd) {
    state.kp = Math.round(kp * 100) / 100;
    state.ki = Math.round(ki * 100) / 100;
    state.kd = Math.round(kd * 100) / 100;
    document.getElementById('kpSlider').value = state.kp;
    document.getElementById('kpInput').value = state.kp;
    document.getElementById('kiSlider').value = state.ki;
    document.getElementById('kiInput').value = state.ki;
    document.getElementById('kdSlider').value = state.kd;
    document.getElementById('kdInput').value = state.kd;
    runSim();
  }

  function onRefChange() {
    if (state.refMode === 'single') {
      const input = document.getElementById('refInput');
      const fn = parseMath(input.value);
      input.classList.toggle('invalid', !fn);
      // Read t range
      const tEnd = parseFloat(document.getElementById('tEnd').value);
      if (isFinite(tEnd) && tEnd > 0) {
        state.duration = tEnd;
        state.playTime = Math.min(state.playTime, state.duration);
      }
      if (fn) { state.refFn = fn; runSim(); }
    } else {
      const fn = buildPiecewiseRef();
      if (fn) { state.refFn = fn; runSim(); }
    }
  }

  /* ==========================================================
     WIRE UP CONTROLS
     ========================================================== */
  function init() {
    // Gain sliders
    const gainPairs = [
      ['kpSlider', 'kpInput', 'kp'],
      ['kiSlider', 'kiInput', 'ki'],
      ['kdSlider', 'kdInput', 'kd'],
    ];
    for (const [sliderId, inputId, key] of gainPairs) {
      const slider = document.getElementById(sliderId);
      const input = document.getElementById(inputId);
      slider.addEventListener('input', () => { state[key] = parseFloat(slider.value); input.value = slider.value; runSim(); });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (isFinite(v) && v >= 0) { state[key] = v; slider.value = Math.min(slider.max, v); runSim(); }
      });
    }

    // Plant sliders
    const plantPairs = [
      ['wnSlider', 'wnInput', 'wn'],
      ['zetaSlider', 'zetaInput', 'zeta'],
    ];
    for (const [sliderId, inputId, key] of plantPairs) {
      const slider = document.getElementById(sliderId);
      const input = document.getElementById(inputId);
      slider.addEventListener('input', () => { state[key] = parseFloat(slider.value); input.value = slider.value; runSim(); });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (isFinite(v) && v >= 0) { state[key] = v; slider.value = Math.min(slider.max, v); runSim(); }
      });
    }

    // T-range inputs (single mode)
    document.getElementById('tEnd').addEventListener('input', onRefChange);

    // Reference mode
    document.getElementById('refMode').addEventListener('change', (e) => {
      state.refMode = e.target.value;
      document.getElementById('singleRefGroup').classList.toggle('hidden', state.refMode !== 'single');
      document.getElementById('piecewiseRefGroup').classList.toggle('hidden', state.refMode !== 'piecewise');
      if (state.refMode === 'piecewise') {
        const container = document.getElementById('piecewiseSegments');
        if (container.children.length === 0) {
          addPiecewiseSegment(0, 5, '0');
          addPiecewiseSegment(5, 10, '5');
        }
      }
      onRefChange();
    });

    // Single ref input
    document.getElementById('refInput').addEventListener('input', onRefChange);

    // Add piecewise segment
    document.getElementById('addSegmentBtn').addEventListener('click', () => {
      const container = document.getElementById('piecewiseSegments');
      const segs = container.querySelectorAll('.pw-segment');
      let lo = 0;
      if (segs.length > 0) {
        const lastHi = segs[segs.length - 1].querySelector('.pw-hi');
        lo = parseFloat(lastHi.value) || 0;
      }
      addPiecewiseSegment(lo, lo + 5, '0');
      onRefChange();
    });

    // Noise
    const measToggle = document.getElementById('measNoiseToggle');
    const measAmp = document.getElementById('measNoiseAmp');
    measToggle.addEventListener('change', () => { state.measNoise = measToggle.checked; measAmp.disabled = !measToggle.checked; runSim(); });
    measAmp.addEventListener('input', () => { state.measAmp = parseFloat(measAmp.value); document.getElementById('measNoiseVal').textContent = measAmp.value; runSim(); });

    const procToggle = document.getElementById('procNoiseToggle');
    const procAmp = document.getElementById('procNoiseAmp');
    procToggle.addEventListener('change', () => { state.procNoise = procToggle.checked; procAmp.disabled = !procToggle.checked; runSim(); });
    procAmp.addEventListener('input', () => { state.procAmp = parseFloat(procAmp.value); document.getElementById('procNoiseVal').textContent = procAmp.value; runSim(); });

    document.getElementById('newNoiseBtn').addEventListener('click', () => { state.noiseSeed = Math.floor(Math.random() * 100000); runSim(); });

    // Reset gains
    document.getElementById('resetGainsBtn').addEventListener('click', () => setGains(0, 0, 0));

    // Reset plant
    document.getElementById('resetPlantBtn').addEventListener('click', () => {
      state.wn = 1; state.zeta = 0.5;
      document.getElementById('wnSlider').value = 1;
      document.getElementById('wnInput').value = 1;
      document.getElementById('zetaSlider').value = 0.5;
      document.getElementById('zetaInput').value = 0.5;
      runSim();
    });

    // Method picker (pill toggle)
    let selectedMethod = 'zn';
    const methodBtns = document.querySelectorAll('.method-btn');
    const znOpts = document.getElementById('znOptions');
    const lambdaOpts = document.getElementById('lambdaOptions');

    methodBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        methodBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMethod = btn.getAttribute('data-method');
        znOpts.classList.toggle('hidden', selectedMethod !== 'zn');
        lambdaOpts.classList.toggle('hidden', selectedMethod !== 'lambda');
      });
    });

    // Lambda slider sync
    const lambdaSlider = document.getElementById('lambdaSlider');
    const lambdaInput = document.getElementById('lambdaInput');
    lambdaSlider.addEventListener('input', () => { lambdaInput.value = lambdaSlider.value; });
    lambdaInput.addEventListener('input', () => {
      const v = parseFloat(lambdaInput.value);
      if (isFinite(v) && v > 0) lambdaSlider.value = Math.min(lambdaSlider.max, v);
    });

    // Apply button — dispatches to selected method
    document.getElementById('applyTuneBtn').addEventListener('click', () => {
      const statusEl = document.getElementById('optimizeStatus');
      if (selectedMethod === 'zn') {
        const result = zieglerNichols();
        if (result) {
          setGains(result.kp, result.ki, result.kd);
          statusEl.textContent = `Z-N: Ku=${result.ku.toFixed(2)}, Tu=${result.tu.toFixed(3)}s → Kp=${result.kp.toFixed(2)}, Ki=${result.ki.toFixed(2)}, Kd=${result.kd.toFixed(2)}`;
        } else {
          statusEl.textContent = 'Z-N: Could not find sustained oscillation for this plant.';
        }
      } else {
        const lambda = parseFloat(lambdaInput.value);
        if (!isFinite(lambda) || lambda <= 0) {
          statusEl.textContent = 'Lambda must be a positive number.';
          statusEl.classList.remove('hidden');
          return;
        }
        const result = lambdaTuning(lambda);
        setGains(result.kp, result.ki, result.kd);
        statusEl.textContent = `Lambda (λ=${lambda.toFixed(1)}): Kp=${result.kp.toFixed(2)}, Ki=${result.ki.toFixed(2)}, Kd=${result.kd.toFixed(2)}`;
      }
      statusEl.classList.remove('hidden');
    });

    // Cost function selector
    document.getElementById('costFn').addEventListener('change', () => { updateMetrics(); });

    // Play/Pause
    document.getElementById('playPauseBtn').addEventListener('click', () => {
      if (state.playing) stopPlayback(); else startPlayback();
    });

    // Reset timeline to start
    document.getElementById('resetTimeBtn').addEventListener('click', () => {
      stopPlayback();
      state.playTime = 0;
      updateTimeline();
      drawAll();
    });

    // Timeline
    initTimelineDrag();

    // Resize handler
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawAll, 100);
    });

    // Initial sim
    state.playTime = state.duration; // start at end (full plot visible)
    runSim();
  }

  init();
})();
