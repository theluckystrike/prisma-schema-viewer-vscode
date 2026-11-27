/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = {
    name: '',
    summary: null,
    pageSize: 100,
    page: 0,
    total: 0,
    rows: [],
    selected: null,
    tab: 'blocks',
    req: 0,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function post(msg) {
    state.req += 1;
    vscode.postMessage({ ...msg, req: state.req });
  }

  function fmtSize(n) {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function renderShell() {
    const s = state.summary;
    const errChip = s.findingErrors > 0 ? `<span class="chip bad"><b>Errors:</b> ${s.findingErrors}</span>` : '<span class="chip"><b>Errors:</b> 0</span>';
    const warnChip = s.findingWarnings > 0 ? `<span class="chip warn"><b>Warnings:</b> ${s.findingWarnings}</span>` : '';

    app.innerHTML = `
      <div class="top">
        <div class="title">
          <span class="name">${esc(state.name)}</span>
          <span class="kind">provider ${esc(s.provider)} · ${s.totalLines} lines · ${fmtSize(s.fileSize)} · 100% offline (no Prisma CLI or database calls)</span>
        </div>
        <div class="summary">
          <span class="chip"><b>Models:</b> ${s.modelCount}</span>
          <span class="chip"><b>Enums:</b> ${s.enumCount}</span>
          <span class="chip"><b>Fields:</b> ${s.fieldCount}</span>
          <span class="chip"><b>Relations:</b> ${s.relationCount}</span>
          <span class="chip"><b>Indexes/Keys:</b> ${s.indexCount}</span>
          ${errChip}${warnChip}
        </div>
        <div class="toolbar">
          <input id="q" type="search" placeholder="Filter by model, field, enum, relation..." />
          <select id="kindFilter">
            <option value="">All blocks</option>
            <option value="model">Models &amp; Views</option>
            <option value="enum">Enums</option>
            <option value="config">Datasource &amp; Generator</option>
            <option value="findings">With Findings</option>
          </select>
          <button id="filterBtn" type="button">Filter</button>
          <span class="sep"></span>
          <div id="protools"></div>
        </div>
        <div class="tabs">
          <button class="tab on" data-tab="blocks" type="button">Models &amp; Blocks (${s.rowCount})</button>
          <button class="tab" data-tab="relations" type="button">Relations (${(s.relations || []).length})</button>
          <button class="tab" data-tab="indexes" type="button">Indexes &amp; Keys (${(s.indexes || []).length})</button>
          <button class="tab" data-tab="findings" type="button">Findings (${(s.findings || []).length})</button>
        </div>
        <div id="hint" class="hint"></div>
      </div>
      <div class="main">
        <div id="leftPane" class="tablewrap"></div>
        <div id="detail" class="detail"><p class="muted">Select a model, enum or block to inspect its fields, attributes and findings.</p></div>
      </div>
      <div class="pager">
        <button id="prev" type="button">Prev</button>
        <span id="pageInfo"></span>
        <button id="next" type="button">Next</button>
      </div>
    `;

    const q = document.getElementById('q');
    const kSel = document.getElementById('kindFilter');
    const runFilter = () => {
      state.page = 0;
      post({ type: 'filter', filter: { text: q.value, kind: kSel.value } });
    };
    document.getElementById('filterBtn').addEventListener('click', runFilter);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runFilter(); });
    kSel.addEventListener('change', runFilter);

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        state.tab = btn.dataset.tab;
        renderPane();
      });
    });

    document.getElementById('prev').addEventListener('click', () => {
      if (state.page > 0) { state.page -= 1; loadPage(); }
    });
    document.getElementById('next').addEventListener('click', () => {
      if ((state.page + 1) * state.pageSize < state.total) { state.page += 1; loadPage(); }
    });
  }

  function loadPage() {
    post({ type: 'page', from: state.page * state.pageSize, n: state.pageSize });
  }

  function bindRowClicks(left) {
    left.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const idx = Number(tr.dataset.idx);
        state.selected = idx;
        left.querySelectorAll('tbody tr').forEach((row) => row.classList.toggle('sel', Number(row.dataset.idx) === idx));
        post({ type: 'detail', index: idx });
      });
    });
  }

  function renderPane() {
    const left = document.getElementById('leftPane');
    const pager = document.querySelector('.pager');
    const s = state.summary;

    if (state.tab === 'relations') {
      pager.style.display = 'none';
      const rRows = (s.relations || []).map((r) => `<tr data-idx="${r.rowIndex}"${state.selected === r.rowIndex ? ' class="sel"' : ''}>
        <td class="num">${r.line}</td>
        <td><code>${esc(r.fromModel)}.${esc(r.fromField)}</code></td>
        <td><strong>${esc(r.cardinality)}</strong></td>
        <td><code>${esc(r.toModel)}</code></td>
        <td><code>${esc((r.fields || []).join(', ') || '-')}</code></td>
        <td class="${r.onDelete === 'Cascade' ? 'warn-text' : ''}">${esc(r.onDelete || '-')}</td>
        <td class="${r.hasFk && !r.indexed ? 'warn-text' : 'ok'}">${r.hasFk ? (r.indexed ? 'Indexed' : 'Missing @@index') : '-'}</td>
      </tr>`).join('');
      left.innerHTML = `<table id="grid">
        <thead><tr><th class="num">Line</th><th>Source</th><th>Card</th><th>Target</th><th>FK Columns</th><th>onDelete</th><th>Index</th></tr></thead>
        <tbody>${rRows || '<tr><td colspan="7" class="muted">No @relation edges detected.</td></tr>'}</tbody>
      </table>`;
      bindRowClicks(left);
      return;
    }

    if (state.tab === 'indexes') {
      pager.style.display = 'none';
      const iRows = (s.indexes || []).map((ix) => `<tr data-idx="${ix.rowIndex}"${state.selected === ix.rowIndex ? ' class="sel"' : ''}>
        <td class="num">${ix.line}</td>
        <td><code>${esc(ix.model)}</code></td>
        <td><strong>${esc(ix.kind)}</strong></td>
        <td><code>${esc((ix.fields || []).join(', '))}</code></td>
        <td>${esc(ix.mapName || '-')}</td>
      </tr>`).join('');
      left.innerHTML = `<table id="grid">
        <thead><tr><th class="num">Line</th><th>Model</th><th>Constraint</th><th>Columns</th><th>Map</th></tr></thead>
        <tbody>${iRows || '<tr><td colspan="5" class="muted">No @id, @unique or @@index constraints found.</td></tr>'}</tbody>
      </table>`;
      bindRowClicks(left);
      return;
    }

    if (state.tab === 'findings') {
      pager.style.display = 'none';
      const fRows = (s.findings || []).map((f) => `<tr>
        <td class="${f.severity === 'error' ? 'bad' : 'warn-text'}"><strong>${esc(f.severity.toUpperCase())}</strong></td>
        <td>${esc(f.category)}</td>
        <td><code>${esc(f.rule)}</code></td>
        <td class="num">${f.line}</td>
        <td><code>${esc(f.target)}</code></td>
        <td>${esc(f.message)}</td>
      </tr>`).join('');
      left.innerHTML = fRows
        ? `<table id="grid"><thead><tr><th>Severity</th><th>Category</th><th>Rule</th><th class="num">Line</th><th>Target</th><th>Finding</th></tr></thead><tbody>${fRows}</tbody></table>`
        : '<p class="muted" style="padding:12px;">No static schema, index or relation-safety findings.</p>';
      return;
    }

    pager.style.display = 'flex';
    const body = state.rows.map((r) => {
      const sel = state.selected === r.index ? ' class="sel"' : '';
      const badge = r.badge ? `<span class="badge-muted">${esc(r.badge)}</span>` : '';
      const statusCls = r.errorCount > 0 ? 'bad' : (r.warningCount > 0 ? 'warn-text' : 'ok');
      return `<tr data-idx="${r.index}"${sel}>
        <td class="num">${r.line}</td>
        <td class="${statusCls}"><strong>${esc(r.kind)}</strong>${badge}</td>
        <td><code>${esc(r.name)}</code></td>
        <td><code>${esc(r.signature)}</code></td>
        <td>${esc(r.risk)}</td>
      </tr>`;
    }).join('');
    left.innerHTML = `<table id="grid">
      <thead><tr><th class="num">Line</th><th>Kind</th><th>Block</th><th>Summary</th><th>Status</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted">No matching blocks.</td></tr>'}</tbody>
    </table>`;
    bindRowClicks(left);

    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    document.getElementById('pageInfo').textContent = `Page ${state.page + 1} of ${pages} (${state.total} items)`;
    document.getElementById('prev').disabled = state.page <= 0;
    document.getElementById('next').disabled = (state.page + 1) * state.pageSize >= state.total;
  }

  function renderDetail(d) {
    const el = document.getElementById('detail');
    if (!d) {
      el.innerHTML = '<p class="muted">No item selected.</p>';
      return;
    }
    const attrRows = (d.attrs || []).map((a) => `<tr><td><strong>${esc(a.key)}</strong></td><td><code>${esc(a.value)}</code></td></tr>`).join('');
    const findHtml = (d.findings && d.findings.length)
      ? '<div class="attr-head"><strong>Findings</strong></div>' + d.findings.map((f) => `<div class="error" style="margin:4px 0;padding:6px 10px;"><strong>${esc(f.rule)}</strong>: ${esc(f.message)}</div>`).join('')
      : '';
    const rawHtml = d.raw ? `<div class="attr-head"><strong>Prisma Source</strong></div><pre class="trace">${esc(d.raw)}</pre>` : '';

    el.innerHTML = `
      <div class="dhead"><strong>Line ${d.line}: ${esc(d.kind)} ${esc(d.name)}</strong><span>${esc(d.badge || '')}</span></div>
      <table class="splits"><thead><tr><th>Field / Property</th><th>Definition</th></tr></thead><tbody>${attrRows}</tbody></table>
      ${findHtml}${rawHtml}
    `;
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        if (m.error) {
          app.innerHTML = `<div class="error"><strong>Could not open ${esc(m.name)}</strong><p>${esc(m.error)}</p></div>`;
          return;
        }
        state.name = m.name;
        state.summary = m.summary;
        state.pageSize = m.pageSize || 100;
        state.page = 0;
        renderShell();
        loadPage();
        return;
      case 'pageResult':
        state.total = m.total;
        state.rows = m.rows || [];
        renderPane();
        if (state.rows.length && state.selected == null) {
          state.selected = state.rows[0].index;
          post({ type: 'detail', index: state.selected });
        }
        return;
      case 'filterResult':
        state.total = m.count;
        document.getElementById('hint').textContent = m.count < m.total ? `Showing ${m.count} of ${m.total} items.` : '';
        loadPage();
        return;
      case 'detailResult':
        renderDetail(m.detail);
        return;
      case 'zovoAlso': {
        const anchor = m.anchor && document.getElementById(m.anchor);
        if (anchor && m.html) {
          const old = document.querySelector('.zovo-also');
          if (old) old.remove();
          anchor.insertAdjacentHTML('afterend', m.html);
        }
        return;
      }
      case 'hint':
        if (document.getElementById('hint')) document.getElementById('hint').textContent = m.text || '';
        return;
      default:
    }
  });

  post({ type: 'ready' });
})();
