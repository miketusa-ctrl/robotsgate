// RobotsGate front-end. Builds every element with textContent (never innerHTML with
// remote data), because /api/check returns content from third-party sites.
(function () {
  'use strict';
  var API = (window.ROBOTSGATE_API || '').replace(/\/$/, '');
  var CAT_LABELS = {
    training: 'AI training',
    dataset: 'Open web datasets',
    search: 'AI search / answers',
    user_fetch: 'User-triggered fetchers',
    other: 'Other AI crawlers'
  };
  var registry = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return { error: { message: 'Non-JSON response (HTTP ' + r.status + ')' } }; });
    });
  }

  function actionSelect(id, value) {
    var s = el('select', { id: id });
    [['omit', 'Leave out'], ['block', 'Block'], ['allow', 'Allow']].forEach(function (o) {
      var opt = el('option', { value: o[0] }, o[1]);
      if (o[0] === value) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }

  function buildControls() {
    var cats = $('cat-controls');
    clear(cats);
    var defaults = { training: 'block', dataset: 'block', search: 'omit', user_fetch: 'omit', other: 'omit' };
    Object.keys(CAT_LABELS).forEach(function (c) {
      var w = el('div');
      w.appendChild(el('label', { for: 'cat-' + c }, CAT_LABELS[c]));
      w.appendChild(actionSelect('cat-' + c, defaults[c]));
      cats.appendChild(w);
    });
    var ag = $('agent-controls');
    clear(ag);
    if (!registry) { ag.appendChild(el('p', { class: 'err' }, 'Could not load the crawler registry.')); return; }
    var t = el('table');
    var h = el('tr');
    ['Crawler', 'Operator', 'Group', 'Override'].forEach(function (x) { h.appendChild(el('th', null, x)); });
    t.appendChild(h);
    registry.crawlers.forEach(function (c) {
      var tr = el('tr');
      var name = el('td');
      var a = el('a', { href: c.docs_url, rel: 'noopener noreferrer', target: '_blank' }, c.name);
      name.appendChild(a);
      tr.appendChild(name);
      tr.appendChild(el('td', null, c.operator));
      tr.appendChild(el('td', null, CAT_LABELS[c.category] || c.category));
      var td = el('td');
      var s = el('select', { 'data-agent': c.name });
      [['', '(use group)'], ['block', 'Block'], ['allow', 'Allow'], ['omit', 'Leave out']].forEach(function (o) { s.appendChild(el('option', { value: o[0] }, o[1])); });
      td.appendChild(s);
      tr.appendChild(td);
      t.appendChild(tr);
    });
    ag.appendChild(t);
  }

  function lines(v) { return v.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean); }

  function showError(container, j) {
    var e = j && j.error ? j.error : { message: 'Request failed.' };
    container.appendChild(el('p', { class: 'err' }, e.message));
    if (Array.isArray(e.details)) {
      var ul = el('ul');
      e.details.forEach(function (d) { ul.appendChild(el('li', { class: 'err' }, d)); });
      container.appendChild(ul);
    }
  }

  function generate() {
    var body = { categories: {}, agents: {}, default: $('g-default').value };
    Object.keys(CAT_LABELS).forEach(function (c) { body.categories[c] = $('cat-' + c).value; });
    document.querySelectorAll('select[data-agent]').forEach(function (s) { if (s.value) body.agents[s.getAttribute('data-agent')] = s.value; });
    var dis = lines($('g-disallow').value);
    if (dis.length) body.disallow_paths = dis;
    var sm = $('g-sitemap').value.trim();
    if (sm) body.sitemaps = [sm];
    var custom = $('g-custom').value;
    if (custom.trim()) body.custom_rules = custom;
    var notes = $('g-notes');
    clear(notes);
    api('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (j) {
      $('g-out').hidden = false;
      if (j.error) { $('g-result').value = ''; var li = el('li'); showError(li, j); notes.appendChild(li); return; }
      $('g-result').value = j.robots_txt;
      (j.notes || []).forEach(function (n) { notes.appendChild(el('li', { class: 'warn' }, n)); });
      if (j.personal_agents_note) notes.appendChild(el('li', { class: 'muted' }, j.personal_agents_note));
      if (j.custom_rules_diagnostics) {
        j.custom_rules_diagnostics.errors.concat(j.custom_rules_diagnostics.warnings).forEach(function (d) { notes.appendChild(el('li', { class: 'warn' }, 'Custom rules: ' + d.message)); });
      }
    }).catch(function () { $('g-out').hidden = false; notes.appendChild(el('li', { class: 'err' }, 'Network error.')); });
  }

  function renderValidation(container, j) {
    var list = function (title, items, cls) {
      if (!items || !items.length) return;
      container.appendChild(el('h3', null, title + ' (' + items.length + ')'));
      var ul = el('ul');
      items.forEach(function (d) { ul.appendChild(el('li', { class: cls }, (d.line ? 'Line ' + d.line + ': ' : '') + d.message)); });
      container.appendChild(ul);
    };
    if (j.valid !== undefined) container.appendChild(el('p', { class: j.valid ? 'allowed' : 'blocked' }, j.valid ? 'No syntax errors found.' : 'Errors found.'));
    list('Errors', j.errors, 'err');
    list('Warnings', j.warnings, 'warn');
    list('Notes', j.info, 'muted');
    if (!j.ai_crawlers) return;
    container.appendChild(el('h3', null, 'AI crawlers for path ' + (j.path || '/')));
    var t = el('table');
    var h = el('tr');
    ['Crawler', 'Operator', 'Status', 'Matched group', 'Deciding rule', 'Note'].forEach(function (x) { h.appendChild(el('th', null, x)); });
    t.appendChild(h);
    j.ai_crawlers.forEach(function (c) {
      var tr = el('tr');
      var n = el('td');
      n.appendChild(el('a', { href: c.docs_url, rel: 'noopener noreferrer', target: '_blank' }, c.name));
      tr.appendChild(n);
      tr.appendChild(el('td', null, c.operator));
      tr.appendChild(el('td', { class: c.status }, c.status));
      tr.appendChild(el('td', null, c.matched_group ? c.matched_group + (c.match_type === 'fallback' ? ' (documented fallback)' : '') : 'none'));
      tr.appendChild(el('td', null, c.deciding_rule ? c.deciding_rule.type + ': ' + c.deciding_rule.path + ' (line ' + c.deciding_rule.line + ')' : '-'));
      tr.appendChild(el('td', null, c.note || ''));
      t.appendChild(tr);
    });
    container.appendChild(t);
    renderPersonalAgents(container, j.personal_agents);
  }

  // v0.2.7: what robots.txt can and can't do about personal agents such as Meta's Muse.
  function renderPersonalAgents(container, pa) {
    if (!pa || !pa.findings || !pa.findings.length) return;
    container.appendChild(el('h3', null, 'Personal agents (e.g. Meta Muse)'));
    var ul = el('ul');
    pa.findings.forEach(function (f) { ul.appendChild(el('li', { class: f.level === 'notice' ? 'warn' : 'muted' }, f.message)); });
    container.appendChild(ul);
    if (typeof pa.guide_url === 'string' && pa.guide_url.charAt(0) === '/' && pa.guide_url.charAt(1) !== '/') {
      var p = el('p', { class: 'muted' });
      p.appendChild(el('a', { href: pa.guide_url }, 'Should I let Muse agents onto my site?'));
      if (pa.as_of) p.appendChild(document.createTextNode(' (checked ' + pa.as_of + ')'));
      container.appendChild(p);
    }
    // not-affiliated line wherever Muse is mentioned.
    container.appendChild(el('p', { class: 'muted' }, typeof pa.disclaimer === 'string' && pa.disclaimer ? pa.disclaimer : 'RobotsGate is not affiliated with Meta.'));
  }

  function validate() {
    var out = $('v-out');
    clear(out);
    api('/api/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robots_txt: $('v-text').value, path: $('v-path').value || '/' }) })
      .then(function (j) { if (j.error) return showError(out, j); renderValidation(out, j); })
      .catch(function () { out.appendChild(el('p', { class: 'err' }, 'Network error.')); });
  }

  function check() {
    var out = $('c-out');
    clear(out);
    out.appendChild(el('p', { class: 'muted' }, 'Fetching…'));
    var q = '?url=' + encodeURIComponent($('c-url').value) + '&path=' + encodeURIComponent($('c-path').value || '/');
    api('/api/check' + q).then(function (j) {
      clear(out);
      if (j.error) return showError(out, j);
      out.appendChild(el('p', null, 'Fetched ' + j.final_url + ' (HTTP ' + j.http_status + ').'));
      if (j.message) out.appendChild(el('p', { class: 'warn' }, j.message));
      renderValidation(out, j);
    }).catch(function () { clear(out); out.appendChild(el('p', { class: 'err' }, 'Network error.')); });
  }

  function download() {
    var blob = new Blob([$('g-result').value], { type: 'text/plain' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'robots.txt' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  document.addEventListener('DOMContentLoaded', function () {
    // v0.2.9: MCP client config for this origin (same shape as the static snippet, llms.txt and the README).
    if ($('mcp-config')) $('mcp-config').textContent = JSON.stringify({ mcpServers: { robotsgate: { type: 'http', url: location.origin + '/mcp' } } }, null, 2);
    buildControls();
    api('/api/crawlers').then(function (j) { registry = j && j.crawlers ? j : null; buildControls(); }).catch(function () { buildControls(); });
    $('g-run').addEventListener('click', generate);
    $('v-run').addEventListener('click', validate);
    $('c-run').addEventListener('click', check);
    $('g-copy').addEventListener('click', function () { navigator.clipboard && navigator.clipboard.writeText($('g-result').value); });
    $('g-download').addEventListener('click', download);
    $('g-tovalidate').addEventListener('click', function () { $('v-text').value = $('g-result').value; location.hash = '#validate'; validate(); });
  });
})();
