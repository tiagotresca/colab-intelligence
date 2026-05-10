// Shell HTML partilhado entre views. Gera <html>+<head>+<body>+sidebar+main
// para que cada view só tenha de fornecer o conteúdo central.
//
// Uso:
//   renderShell({
//     title: 'Overview',
//     activePath: 'overview',
//     empresaId: 'uuid',
//     content: '<h1>...</h1>',
//   })

import { DESIGN_SYSTEM_CSS } from './styles.js';

export interface SidebarItem {
  label: string;
  href: string;
  active: boolean;
  icon?: string; // optional emoji/text icon
}

export interface ShellArgs {
  title: string;
  empresaId: string | null;
  activePath: 'overview' | 'audit';
  content: string; // HTML do main content
}

export function renderShell(args: ShellArgs): string {
  const { title, empresaId, activePath, content } = args;

  const navItems: SidebarItem[] = empresaId
    ? [
        {
          label: 'Overview',
          href: `/dashboard?empresa=${empresaId}`,
          active: activePath === 'overview',
          icon: '◉',
        },
        {
          label: 'Audit',
          href: `/dashboard?view=audit&empresa=${empresaId}`,
          active: activePath === 'audit',
          icon: '◈',
        },
      ]
    : [];

  const sidebarLinks = navItems
    .map(
      (it) =>
        `<a href="${it.href}" class="sidebar-link${it.active ? ' sidebar-link-active' : ''}">
          <span style="opacity: 0.5; font-size: 11px;">${it.icon ?? '·'}</span>
          <span>${it.label}</span>
        </a>`,
    )
    .join('');

  const now = new Date().toLocaleString('pt-PT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<title>${escape(title)} — colab-intelligence</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>${DESIGN_SYSTEM_CSS}</style>
</head>
<body>
<div class="app-layout">
  <aside class="sidebar">
    <div class="sidebar-brand">colab-intelligence</div>
    ${navItems.length > 0 ? `<nav class="sidebar-nav">${sidebarLinks}</nav>` : ''}
    <div class="sidebar-spacer"></div>
    <div class="sidebar-footer">${escape(now)}</div>
  </aside>
  <main class="main">
    ${content}
  </main>
</div>
</body>
</html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
