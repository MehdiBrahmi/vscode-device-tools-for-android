(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.LogFilter = factory(); }
})(this, function () {
  const LEVELS = { V: 2, VERBOSE: 2, D: 3, DEBUG: 3, I: 4, INFO: 4, W: 5, WARN: 5, WARNING: 5, E: 6, ERROR: 6, F: 7, A: 7, ASSERT: 7, FATAL: 7 };
  const KEYS = ['tag', 'package', 'process', 'message', 'line', 'level', 'age', 'is', 'name'];
  const KEY_RE = /^(-?)([a-z]+)([~=]?):/i;

  function unquote(v) {
    if (v[0] !== '"') { return v; }
    let out = '';
    for (let i = 1; i < v.length; i++) {
      if (v[i] === '\\' && i + 1 < v.length) { out += v[++i]; } else if (v[i] === '"') { break; } else { out += v[i]; }
    }
    return out;
  }

  // Splits on whitespace (quotes protect spaces) and emits operator / term tokens with source ranges for highlighting.
  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(' || c === ')') { toks.push({ t: 'op', v: c, s: i, e: i + 1 }); i++; continue; }
      const s = i;
      let inQ = false;
      while (i < src.length) {
        const ch = src[i];
        if (inQ) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === '"') { inQ = false; }
          i++; continue;
        }
        if (ch === '"') { inQ = true; i++; continue; }
        if (/\s/.test(ch)) { break; }
        i++;
      }
      let word = src.slice(s, i), e = i;
      // trailing ')' that is not balanced inside the word is a closing paren
      let closers = 0;
      while (word.endsWith(')') && (word.split(')').length - 1) > (word.split('(').length - 1)) { word = word.slice(0, -1); closers++; e--; }
      if (word === '|' || word === '||') { toks.push({ t: 'op', v: '|', s, e }); } else if (word === '&' || word === '&&') { toks.push({ t: 'op', v: '&', s, e }); } else if (word) {
        const m = KEY_RE.exec(word);
        if (m && KEYS.includes(m[2].toLowerCase())) {
          const raw = word.slice(m[0].length);
          toks.push({ t: 'term', s, e, key: m[2].toLowerCase(), neg: m[1] === '-', mode: m[3], value: unquote(raw), valueStart: s + m[0].length });
        } else {
          toks.push({ t: 'term', s, e, key: null, neg: false, mode: '', value: unquote(word), valueStart: s });
        }
      }
      for (let k = 0; k < closers; k++) { toks.push({ t: 'op', v: ')', s: e + k, e: e + k + 1 }); }
    }
    return toks;
  }

  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    function orExpr() {
      let l = andExpr();
      while (peek() && peek().t === 'op' && peek().v === '|') { p++; const r = andExpr(); l = { op: 'or', l, r }; }
      return l;
    }
    function andExpr() {
      let l = unary();
      for (;;) {
        const t = peek();
        if (!t || (t.t === 'op' && (t.v === '|' || t.v === ')'))) { break; }
        if (t.t === 'op' && t.v === '&') { p++; }
        const r = unary();
        l = { op: 'and', l, r };
      }
      return l;
    }
    function unary() {
      const t = peek();
      if (!t) { throw new Error('Unexpected end of filter'); }
      if (t.t === 'op' && t.v === '(') {
        p++;
        const e = orExpr();
        if (!peek() || peek().v !== ')') { throw new Error('Missing )'); }
        p++;
        return e;
      }
      if (t.t === 'op') { throw new Error(`Unexpected ${t.v}`); }
      p++;
      return { op: 'term', term: t };
    }
    try {
      if (!toks.length) { return { toks, ast: null }; }
      const ast = orExpr();
      if (p < toks.length) { throw new Error(`Unexpected ${toks[p].v ?? toks[p].value}`); }
      return { toks, ast };
    } catch (e) {
      return { toks, ast: null, error: e.message };
    }
  }

  const AGE_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

  function textMatcher(term, ctx) {
    const cs = !!(ctx && ctx().matchCase);
    const v = term.value;
    if (term.mode === '~') {
      const re = new RegExp(v, cs || /[A-Z]/.test(v) ? '' : 'i');
      return (s) => re.test(s);
    }
    if (cs) {
      if (term.mode === '=') { return (s) => s === v; }
      return (s) => s.includes(v);
    }
    const lv = v.toLowerCase();
    if (term.mode === '=') { return (s) => s.toLowerCase() === lv; }
    return (s) => s.toLowerCase().includes(lv);
  }

  function termPredicate(term, ctx) {
    let fn;
    switch (term.key) {
      case null: { const m = textMatcher(term, ctx); fn = (e) => m(`${e.tag} ${e.pkg} ${e.lines.join('\n')}`); break; }
      case 'tag': case 'name': { const m = textMatcher(term, ctx); fn = (e) => m(e.tag); break; }
      case 'package': case 'process': {
        if (term.value === 'mine') { fn = (e) => !!e.pkg && ctx().mine.includes(e.pkg); break; }
        const m = textMatcher(term, ctx); fn = (e) => m(e.pkg || ''); break;
      }
      case 'message': { const m = textMatcher(term, ctx); fn = (e) => m(e.lines.join('\n')); break; }
      case 'line': { const m = textMatcher(term, ctx); fn = (e) => m(`${e.tag} ${e.pkg} ${e.lines.join('\n')}`); break; }
      case 'level': {
        const n = LEVELS[term.value.toUpperCase()];
        if (!n) { throw new Error(`Unknown level ${term.value}`); }
        fn = term.mode === '=' ? (e) => e.lvn === n : (e) => e.lvn >= n; break;
      }
      case 'age': {
        const m = /^(\d+)\s*([smhd])$/i.exec(term.value);
        if (!m) { throw new Error('age expects e.g. 5m, 30s, 2h'); }
        const ms = Number(m[1]) * AGE_MS[m[2].toLowerCase()];
        fn = (e) => Date.now() - e.rx <= ms; break;
      }
      case 'is': {
        const v = term.value.toLowerCase();
        if (v === 'crash') { fn = (e) => (e.tag === 'AndroidRuntime' && e.lvn >= 6) || e.lines[0].startsWith('FATAL EXCEPTION') || e.lines[0].startsWith('*** *** ***'); } else if (v === 'stacktrace') { fn = (e) => e.lines.some((l) => /^\s+at\s+\S+\(.*\)|^Caused by: /.test(l)); } else if (v === 'firebase') { fn = (e) => /^(Firebase|FA\b|FirebaseCrashlytics)/.test(e.tag); } else { throw new Error(`Unknown is:${term.value}`); }
        break;
      }
      default: throw new Error(`Unknown key ${term.key}`);
    }
    return term.neg ? (e) => !fn(e) : fn;
  }

  function compile(src, ctx) {
    const r = parse(src);
    if (r.error) { return { error: r.error, toks: r.toks, test: () => true }; }
    if (!r.ast) { return { toks: r.toks, test: () => true }; }
    try {
      const build = (n) => {
        if (n.op === 'term') { return termPredicate(n.term, ctx); }
        const l = build(n.l), rr = build(n.r);
        return n.op === 'and' ? (e) => l(e) && rr(e) : (e) => l(e) || rr(e);
      };
      return { toks: r.toks, test: build(r.ast) };
    } catch (e) {
      return { error: e.message, toks: r.toks, test: () => true };
    }
  }

  return { tokenize, parse, compile, LEVELS };
});
