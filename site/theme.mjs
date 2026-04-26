import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSite = name => readFile(join(here, name), 'utf8');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const renderNav = nav => (nav || []).map(n => `<a href="${esc(n.href)}">${esc(n.label)}</a>`).join('');

const renderCta = cta => (cta || []).map(b => {
    const cls = b.kind === 'green' ? 'btn-primary' : 'btn-ghost';
    return `<a class="${cls}" href="${esc(b.href)}">${esc(b.label)}</a>`;
}).join(' ');

const accentForIndex = i => ['green', 'purple', 'mascot', 'sun', 'flame', 'sky'][i % 6];

const renderSection = (s, i) => `
<section class="ww-section" id="${esc(s.id)}">
  <div class="dateline">
    <span class="ww-mark" data-accent="${accentForIndex(i)}">${esc(s.label)}</span>
    <span class="spread"></span>
    <span>${esc(s.id)}</span>
  </div>
  <h2>${esc(s.title)}</h2>
  <div class="ww-prose"><p>${md(s.body)}</p></div>
  ${s.code ? `<pre class="ww-code"><code>${esc(s.code)}</code></pre>` : ''}
</section>`;

const renderModules = mods => `
<section class="ww-section" id="modules">
  <div class="dateline"><span>// modules</span><span class="spread"></span><span>${(mods || []).length} files</span></div>
  <div class="ww-rows">
    ${(mods || []).map(m => `
      <a class="row" href="https://github.com/AnEntrypoint/wireweave/blob/master/src/${esc(m.slug)}.js">
        <div class="row-code">// ${esc(m.code)}</div>
        <div class="row-title">${esc(m.slug)}<div class="ww-blurb">${md(m.blurb)}</div></div>
        <div class="row-meta">${esc(m.meta)}</div>
      </a>
    `).join('')}
  </div>
</section>`;

const layout = ({ header, footer, page, siteCss }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#247420" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#3A9A34" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<title>${esc(page.title)} — ${esc(header.tagline)}</title>
<meta name="description" content="${esc(page.hero.lede)}">
<meta property="og:title" content="${esc(page.title)} — ${esc(header.tagline)}">
<meta property="og:description" content="${esc(page.hero.lede)}">
<meta property="og:url" content="https://anentrypoint.github.io/wireweave/">
<meta property="og:type" content="website">
<link rel="canonical" href="https://anentrypoint.github.io/wireweave/">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="stylesheet" href="colors_and_type.css">
<link rel="stylesheet" href="app-shell.css">
<style>${siteCss}</style>
</head>
<body>
<header class="app-topbar">
  <span class="brand">${esc(header.brand)}<span class="slash"> / </span>${esc(header.tagline.split('.')[0])}</span>
  <nav>${renderNav(header.nav)}</nav>
</header>

<main class="ww-page">
  <section class="ww-hero">
    <div class="dateline"><span>247420 // wireweave</span><span class="spread"></span><span>probably emerging 🌀</span></div>
    <span class="stamp green">${esc(page.hero.stamp)}</span>
    <h1>${esc(page.hero.headline)}</h1>
    <p class="ww-lede">${esc(page.hero.lede)}</p>
    <div class="ww-cta">${renderCta(page.hero.cta)}</div>
  </section>

  ${(page.sections || []).map(renderSection).join('')}
  ${renderModules(page.modules)}
</main>

<footer class="app-status">
  <span class="item">${esc(footer.left)}</span>
  ${(footer.links || []).map(l => `<a class="item" href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}
  <span class="spread"></span>
  <span class="item">${esc(footer.right)}</span>
  <span class="item">• probably emerging</span>
</footer>
</body>
</html>`;

const SITE_CSS = `
.ww-page { max-width: 1100px; margin: 0 auto; padding: var(--space-7) var(--space-5); display: flex; flex-direction: column; gap: var(--space-7); }
.ww-hero { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-7) 0 var(--space-5); }
.ww-hero .stamp { align-self: flex-start; }
.ww-hero h1 { font-family: var(--ff-display); font-size: clamp(48px, 10vw, var(--fs-hero)); line-height: var(--lh-tight); letter-spacing: var(--tr-tight); margin: 0; max-width: 14ch; }
.ww-lede { font-family: var(--ff-prose); font-size: var(--fs-lg); line-height: var(--lh-long); max-width: 60ch; color: var(--panel-text-2); margin: 0; }
.ww-cta { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-3); }

.ww-section { display: flex; flex-direction: column; gap: var(--space-4); }
.ww-section h2 { font-family: var(--ff-display); font-size: var(--fs-h1); line-height: var(--lh-tight); letter-spacing: var(--tr-tight); margin: 0; max-width: 18ch; }
.ww-prose p { font-family: var(--ff-prose); font-size: var(--fs-lg); line-height: var(--lh-long); max-width: 60ch; color: var(--panel-text-2); margin: 0; }
.ww-prose code { font-family: var(--ff-mono); font-size: 0.95em; background: var(--panel-2); padding: 0 4px; border-radius: var(--r-2); }

.ww-mark[data-accent="green"]   { color: var(--green); }
.ww-mark[data-accent="purple"]  { color: var(--purple-2); }
.ww-mark[data-accent="mascot"]  { color: var(--mascot); }
.ww-mark[data-accent="sun"]     { color: var(--sun); }
.ww-mark[data-accent="flame"]   { color: var(--flame); }
.ww-mark[data-accent="sky"]     { color: var(--sky); }

.ww-code { font-family: var(--ff-mono); font-size: var(--fs-sm); line-height: var(--lh-base); background: var(--panel-1); border-radius: var(--r-3); padding: var(--space-4); overflow-x: auto; white-space: pre; color: var(--panel-text); }
.ww-code code { background: transparent; padding: 0; }

.ww-rows { display: flex; flex-direction: column; gap: var(--space-2); }
.ww-rows .row { text-decoration: none; color: inherit; }
.ww-blurb { font-family: var(--ff-prose); font-size: var(--fs-sm); font-weight: 400; letter-spacing: 0; color: var(--panel-text-2); margin-top: var(--space-2); max-width: 60ch; }
.ww-rows .row:hover .ww-blurb { color: var(--green-fg); }

.app-status .item { font-family: var(--ff-mono); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: var(--tr-label); color: var(--panel-text-2); text-decoration: none; padding: 0 var(--space-3); }
.app-status a.item:hover { color: var(--panel-accent); }

@media (max-width: 640px) {
  .ww-page { padding: var(--space-5) var(--space-3); }
  .ww-section h2 { font-size: var(--fs-h2); }
  .row { grid-template-columns: 64px 1fr; }
  .row .row-meta { grid-column: 2; }
}
`;

export default {
    render: async (ctx) => {
        const header = ctx.readGlobal('header');
        const footer = ctx.readGlobal('footer');
        const { docs } = ctx.read('pages', { where: { slug: { equals: 'home' } }, limit: 1 });
        const page = docs[0];
        if (!page) throw new Error('content/pages/home.yaml not found');

        const [tokensCss, shellCss, favicon] = await Promise.all([
            readSite('colors_and_type.css'),
            readSite('app-shell.css'),
            readSite('favicon.svg')
        ]);

        return [
            { path: 'index.html', html: layout({ header, footer, page, siteCss: SITE_CSS }) },
            { path: 'colors_and_type.css', html: tokensCss },
            { path: 'app-shell.css', html: shellCss },
            { path: 'favicon.svg', html: favicon },
            { path: '.nojekyll', html: '' }
        ];
    }
};
