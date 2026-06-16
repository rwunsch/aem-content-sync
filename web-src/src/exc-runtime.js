/*
 * Loads the Adobe Experience Cloud Module Runtime (EMR).
 *
 * The Experience Cloud Shell iframes the app at `…/?_mr=<runtime-script-url>`.
 * This loader reads that `_mr` param, validates it, injects the EMR <script>,
 * and on load calls `window.EXC_MR_READY()` — which is what `@adobe/exc-app`'s
 * `init()` waits for before invoking the bootstrap callback (where we receive
 * the IMS token via the 'ready' event).
 *
 * It throws synchronously when NOT inside the shell iframe (standalone / direct
 * load), so index.js can fall back to a token-less render.
 *
 * This is the canonical loader from @adobe/generator-add-web-assets-exc-react
 * (templates/src/exc-runtime.js) — kept verbatim so the handshake matches what
 * the shell expects.
 */
/* eslint-disable */
(function (e, t) {
  if (t.location === t.parent.location) throw new Error('Module Runtime: Needs to be within an iframe!')
  var o = (function (e) { var t = new URL(e.location.href).searchParams.get('_mr'); return t || !e.EXC_US_HMR ? t : e.sessionStorage.getItem('unifiedShellMRScript') })(t)
  if (!o) throw new Error('Module Runtime: Missing script!')
  if ('https:' !== (o = new URL(decodeURIComponent(o))).protocol) throw new Error('Module Runtime: Must be HTTPS!')
  if (!/^(exc-unifiedcontent\.)?experience(-qa|-stage|-cdn|-cdn-stage)?\.adobe\.(com|net)$/.test(o.hostname) && !/localhost\.corp\.adobe\.com$/.test(o.hostname)) throw new Error('Module Runtime: Invalid domain!')
  if (!/\.js$/.test(o.pathname)) throw new Error('Module Runtime: Must be a JavaScript file!')
  t.EXC_US_HMR && t.sessionStorage.setItem('unifiedShellMRScript', o.toString())
  var n = e.createElement('script')
  n.async = 1
  n.src = o.toString()
  n.onload = n.onreadystatechange = function () { n.readyState && !/loaded|complete/.test(n.readyState) || (n.onload = n.onreadystatechange = null, n = void 0, 'EXC_MR_READY' in t && t.EXC_MR_READY()) }
  e.head.appendChild(n)
})(document, window)
