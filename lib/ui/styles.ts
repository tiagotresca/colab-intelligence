// CSS partilhado entre dashboard views (Overview, Audit, futuras).
//
// Design system inspirado em Shopify Polaris:
//   - Light mode (fundo claro, cards brancos)
//   - Inter / SF Pro typography com weights 400/500/600
//   - Border-radius 12px nos cards
//   - Cantos suaves, espaçamento generoso
//   - Cores de estado: verde (good/scale), amarelo (watch), vermelho (kill/critical), azul (info), roxo (insight/AI)
//
// Single source of truth para tokens — qualquer change ao look-and-feel
// muda aqui e propaga.

export const DESIGN_SYSTEM_CSS = `
/* ===== Reset + base ===== */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font: 14px/1.5 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #F8FAFC;
  color: #1F2937;
  font-feature-settings: 'cv11', 'ss01';
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ===== Layout: sidebar + main ===== */
.app-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}

.sidebar {
  background: #FFFFFF;
  border-right: 1px solid #E5E7EB;
  padding: 24px 16px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.sidebar-brand {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 24px;
  padding: 0 8px;
  letter-spacing: -0.01em;
}
.sidebar-nav { display: flex; flex-direction: column; gap: 2px; }
.sidebar-section-label {
  font-size: 11px;
  text-transform: uppercase;
  color: #9CA3AF;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 12px 8px 4px;
}
.sidebar-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  color: #4B5563;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.1s;
}
.sidebar-link:hover { background: #F3F4F6; color: #111827; }
.sidebar-link-active { background: #F3F4F6; color: #111827; }
.sidebar-spacer { flex: 1; }
.sidebar-footer {
  font-size: 11px;
  color: #9CA3AF;
  padding: 8px;
  margin-top: 12px;
  border-top: 1px solid #F3F4F6;
}

.main {
  padding: 32px 40px;
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 768px) {
  .app-layout { grid-template-columns: 1fr; }
  .sidebar { position: relative; height: auto; border-right: none; border-bottom: 1px solid #E5E7EB; }
  .main { padding: 20px 16px; }
}

/* ===== Typography ===== */
.page-h {
  font-size: 24px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 4px;
  letter-spacing: -0.02em;
}
.page-sub {
  font-size: 14px;
  color: #6B7280;
  margin: 0 0 24px;
}
.section-h {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6B7280;
  margin: 24px 0 12px;
}

/* ===== Toolbar (top of main, with controls) ===== */
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 24px;
  flex-wrap: wrap;
}
.toolbar-spacer { flex: 1; }

/* ===== Form controls ===== */
select, input, button {
  font-family: inherit;
  font-size: 14px;
}
.input, select.input {
  background: #FFFFFF;
  color: #1F2937;
  border: 1px solid #D1D5DB;
  padding: 8px 12px;
  border-radius: 8px;
  font-weight: 500;
  transition: border-color 0.1s;
}
.input:hover, select.input:hover { border-color: #9CA3AF; }
.input:focus, select.input:focus {
  outline: none;
  border-color: #6E5BC9;
  box-shadow: 0 0 0 3px rgba(110, 91, 201, 0.15);
}

.btn {
  background: #FFFFFF;
  color: #1F2937;
  border: 1px solid #D1D5DB;
  padding: 8px 14px;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.1s;
}
.btn:hover { background: #F9FAFB; border-color: #9CA3AF; }
.btn-primary {
  background: #1F2937;
  color: #FFFFFF;
  border-color: #1F2937;
}
.btn-primary:hover { background: #374151; border-color: #374151; }
.btn-accent {
  background: #6E5BC9;
  color: #FFFFFF;
  border-color: #6E5BC9;
}
.btn-accent:hover { background: #5443A3; border-color: #5443A3; }

/* ===== Cards ===== */
.card {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.card + .card { margin-top: 16px; }

/* ===== KPI cards grid ===== */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.kpi-card {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.kpi-card-label {
  font-size: 12px;
  font-weight: 500;
  color: #6B7280;
  margin: 0 0 8px;
}
.kpi-card-value {
  font-size: 24px;
  font-weight: 600;
  color: #111827;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

/* ===== Tables ===== */
.table-wrap {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
table.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
table.data th {
  text-align: left;
  padding: 12px 16px;
  background: #F9FAFB;
  color: #6B7280;
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid #E5E7EB;
}
table.data td {
  padding: 12px 16px;
  border-bottom: 1px solid #F3F4F6;
  font-variant-numeric: tabular-nums;
  color: #1F2937;
}
table.data tr:last-child td { border-bottom: none; }
table.data .err-msg { color: #DC2626; font-size: 12px; }
table.data .muted { color: #9CA3AF; }

/* ===== Status badges ===== */
.status {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.status.ok { background: #D1FAE5; color: #065F46; }
.status.warn { background: #FEF3C7; color: #92400E; }
.status.err { background: #FEE2E2; color: #991B1B; }
.status.info { background: #DBEAFE; color: #1E40AF; }

/* ===== Toast / banner ===== */
.toast {
  background: #ECFDF5;
  color: #065F46;
  border: 1px solid #A7F3D0;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 14px;
}
.toast-error {
  background: #FEF2F2;
  color: #991B1B;
  border-color: #FECACA;
}

/* ===== Helpers ===== */
.muted { color: #6B7280; }
.text-secondary { color: #6B7280; }
.text-tertiary { color: #9CA3AF; }
.flex { display: flex; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
.gap-4 { gap: 16px; }
.items-center { align-items: center; }

/* ===== Sparkline (kept simple) ===== */
.sparkline-wrap {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 24px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.sparkline-wrap > .label {
  font-size: 12px;
  font-weight: 500;
  color: #6B7280;
  margin-bottom: 8px;
}

/* ===== Audit-specific ===== */
.summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.summary-badge {
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.summary-ok { background: #D1FAE5; color: #065F46; }
.summary-info { background: #DBEAFE; color: #1E40AF; }
.summary-warning { background: #FEF3C7; color: #92400E; }
.summary-critical { background: #FEE2E2; color: #991B1B; }

.audit-section-h {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6B7280;
  margin: 24px 0 12px;
}
.checks { display: flex; flex-direction: column; gap: 8px; }
.check {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-left: 4px solid #E5E7EB;
  border-radius: 12px;
  padding: 16px 20px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.check-ok { border-left-color: #10B981; }
.check-info { border-left-color: #3B82F6; }
.check-warning { border-left-color: #F59E0B; }
.check-critical { border-left-color: #EF4444; }
.check-header { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.check-severity {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 4px;
  background: #F3F4F6;
}
.check-ok .check-severity { color: #065F46; background: #D1FAE5; }
.check-info .check-severity { color: #1E40AF; background: #DBEAFE; }
.check-warning .check-severity { color: #92400E; background: #FEF3C7; }
.check-critical .check-severity { color: #991B1B; background: #FEE2E2; }
.check-name { font-weight: 600; flex: 1; color: #111827; }
.check-count { font-variant-numeric: tabular-nums; color: #6B7280; font-size: 13px; }
.check-message { color: #4B5563; font-size: 13px; margin-top: 4px; }
.check-hint { margin-top: 8px; font-size: 12px; color: #6B7280; }
.check-examples { margin-top: 6px; font-size: 11px; color: #6B7280; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace; }

.resynth-wrap {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 24px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.resynth-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.resynth-label { color: #6B7280; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }

/* ===== Import wrap ===== */
.import-wrap {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 24px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.import-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.import-status { font-size: 12px; color: #6B7280; margin-left: auto; }
.import-status.pending { color: #92400E; }
.import-status.success { color: #065F46; }
.import-status.error { color: #991B1B; }

/* ===== Card sub-content (for raw counts inside KPI grid) ===== */
.raw-counts {
  display: flex;
  gap: 24px;
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 24px;
  flex-wrap: wrap;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.raw-counts .item { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.raw-counts .label {
  font-size: 11px;
  text-transform: uppercase;
  color: #9CA3AF;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.raw-counts .value {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: #111827;
}

.card-sub { color: #9CA3AF; font-size: 12px; margin-top: 4px; }

/* ===== Details / collapsible ===== */
details {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 16px 20px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
details summary {
  cursor: pointer;
  color: #6B7280;
  font-size: 13px;
  font-weight: 500;
  user-select: none;
}
details pre {
  background: #F9FAFB;
  padding: 16px;
  border-radius: 8px;
  overflow: auto;
  font: 12px/1.5 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  margin: 12px 0 0;
  color: #1F2937;
  border: 1px solid #E5E7EB;
}

/* ===== Backwards-compatible aliases (legacy class names usados nos renders) ===== */
h2 {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6B7280;
  margin: 24px 0 12px;
}
.controls {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.controls > label { color: #6B7280; font-size: 13px; font-weight: 500; }
.controls select {
  background: #FFFFFF;
  color: #1F2937;
  border: 1px solid #D1D5DB;
  padding: 8px 12px;
  border-radius: 8px;
  font-weight: 500;
  font-family: inherit;
  font-size: 14px;
}
.controls select:hover { border-color: #9CA3AF; }
.controls select:focus { outline: none; border-color: #6E5BC9; box-shadow: 0 0 0 3px rgba(110, 91, 201, 0.15); }
button.primary, .btn.primary {
  background: #6E5BC9;
  color: #FFFFFF;
  border: 1px solid #6E5BC9;
  padding: 8px 14px;
  border-radius: 8px;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.1s, border-color 0.1s;
}
button.primary:hover { background: #5443A3; border-color: #5443A3; }
.btn-secondary {
  background: #FFFFFF;
  color: #1F2937;
  border: 1px solid #D1D5DB;
  padding: 8px 14px;
  border-radius: 8px;
  font-weight: 500;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.1s;
}
.btn-secondary:hover { background: #F9FAFB; border-color: #9CA3AF; }
.import-label { color: #6B7280; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.sub-h3 {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6B7280;
  margin: 16px 0 8px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.cards .card {
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  margin-top: 0;
}
.cards .card .label {
  font-size: 11px;
  font-weight: 500;
  color: #6B7280;
  margin-bottom: 8px;
  text-transform: none;
  letter-spacing: 0;
}
.cards .card .value {
  font-size: 22px;
  font-weight: 600;
  color: #111827;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
table th {
  text-align: left;
  padding: 12px 16px;
  background: #F9FAFB;
  color: #6B7280;
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid #E5E7EB;
}
table td {
  padding: 12px 16px;
  border-bottom: 1px solid #F3F4F6;
  font-variant-numeric: tabular-nums;
  color: #1F2937;
}
table tr:last-child td { border-bottom: none; }
table .err-msg, table td.err-msg { color: #DC2626; font-size: 12px; }
`;
