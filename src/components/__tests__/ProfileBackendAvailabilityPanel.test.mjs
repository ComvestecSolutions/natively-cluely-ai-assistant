import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../ProfileIntelligenceSettings.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

function mount(status, data = null) {
  const slots = [], effects = [], calls = [];
  let cursor = 0, tree;
  const api = {
    licenseGetDetails: async () => ({ isPremium: true, plan: 'pro' }),
    profileGetStatus: async () => {
      if (status === null) throw new Error('status IPC failed');
      return status;
    },
    profileGetProfile: async () => data,
    profileGetCompanyDossier: async () => null,
    getStoredCredentials: async () => ({}),
    answerPolicyGet: async () => ({ v3Enabled: false }),
    profileSelectFile: async () => { calls.push('select-file'); return { cancelled: true }; },
    profileSetMode: async () => { calls.push('set-mode'); return { success: true }; },
    profileResearchCompany: async () => { calls.push('research'); return { success: true }; },
    profileGenerateCoverLetter: async () => { calls.push('letter'); return { success: true }; },
    funnelTrack: async () => {},
  };
  const window = { electronAPI: api, localStorage: { getItem: () => '1', setItem() {}, removeItem() {} } };
  const hooks = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof value === 'function' ? value() : value };
      return [slots[i].value, update => { slots[i].value = typeof update === 'function' ? update(slots[i].value) : update; }];
    },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect(callback, deps) {
      const i = cursor++, old = slots[i];
      if (deps && old?.deps && deps.length === old.deps.length && deps.every((x, j) => Object.is(x, old.deps[j]))) return;
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; });
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const modules = {
    './settings/useToggleInit': { useToggleInit: () => ({ arm() {}, className: '' }) },
    '../premium': { RoleInsightPanel: () => null },
    '../hooks/useResolvedTheme': { useResolvedTheme: () => 'dark' },
    '../ui-components/LiquidGlassButton': { LiquidGlassButton: 'button', useLensTracking: () => ({ ref: { current: null }, onPointerMove() {}, onFocus() {} }) },
    '../utils/resumeSummary.mjs': { truncateResumeSummary: s => s },
    '../config/urls': { CHECKOUT_URLS: { apiMax: 'https://example.invalid' } },
    './ui/ConfirmDialog': { useConfirmDialog: () => ({ confirm: async () => false, dialog: null }) },
    'thinking-orbs': { ThinkingOrb: 'orb' },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, module: { exports }, window, console, setTimeout, clearTimeout,
    require: id => id === 'react' ? { ...hooks, default: hooks }
      : id === 'lucide-react' ? new Proxy({}, { get: () => 'icon' }) : (modules[id] ?? {}),
  }, { filename: 'ProfileIntelligenceSettings.js' });
  const render = () => { cursor = 0; tree = exports.ProfileIntelligenceSettings({ onClose() {} }); effects.splice(0).forEach(fn => fn()); };
  const settle = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); render(); } };
  const nodes = () => {
    const all = [];
    const walk = node => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      all.push(node);
      if (typeof node.type === 'function') walk(node.type(node.props));
      node.children?.forEach(walk);
    };
    walk(tree); return all;
  };
  render();
  return { settle, nodes, calls, nav(label) {
    const item = nodes().find(n => n.props.className?.includes?.('pi-nav-item') && n.children.some(child => child?.type === 'span' && child.children.includes(label)));
    assert.ok(item, `section ${label} exists`); item.props.onClick(); render();
  } };
}

const missing = { hasProfile: false, profileMode: false, backendAvailable: false,
  backendUnavailable: 'knowledge_engine_unavailable' };

test('mounted panel names the missing engine and disables upload, while preserving Tavily settings', async () => {
  const h = mount(missing);
  await h.settle();
  const alert = h.nodes().find(n => n.props.role === 'alert' && n.props['data-profile-backend-unavailable']);
  assert.ok(alert, 'explain why Profile Intelligence cannot operate');
  assert.match(JSON.stringify(alert.children), /knowledge engine.*unavailable/i);
  const uploads = h.nodes().filter(n => n.type === 'button' && n.props.className === 'pi-upload-btn');
  assert.equal(uploads.length, 2, 'resume and job-description uploads remain visible');
  for (const upload of uploads) {
    assert.equal(upload.props.disabled, true);
    upload.props.onClick();
  }
  assert.deepEqual(h.calls, []);
  h.nav('Tavily Search');
  assert.ok(h.nodes().some(n => n.props['data-genie-view'] === 'tavily'), 'independent key settings remain navigable');
});

test('mounted panel distinguishes an operational engine with no résumé: upload remains possible', async () => {
  const h = mount({ hasProfile: false, profileMode: false, backendAvailable: true, backendUnavailable: null });
  await h.settle();
  assert.equal(h.nodes().some(n => n.props.role === 'alert' && n.props['data-profile-backend-unavailable']), false);
  const upload = h.nodes().find(n => n.type === 'button' && n.props.className === 'pi-upload-btn');
  assert.equal(upload?.props.disabled, false);
  upload.props.onClick(); await h.settle();
  assert.deepEqual(h.calls, ['select-file']);
});

test('status IPC failure also leaves uploads disabled with a distinct warning', async () => {
  const h = mount(null);
  await h.settle();
  const alert = h.nodes().find(n => n.props['data-profile-backend-unavailable']);
  assert.match(JSON.stringify(alert?.children), /status could not be confirmed/i);
  assert.ok(h.nodes().filter(n => n.props.className === 'pi-upload-btn').every(n => n.props.disabled));
});

test('stale profile data cannot enable engine-backed controls when status reports missing backend', async () => {
  const h = mount({ ...missing, hasProfile: true, profileMode: true }, {
    identity: { name: 'Candidate' }, hasActiveJD: true, activeJD: { company: 'Example', title: 'Analyst' },
  });
  await h.settle();
  const toggle = h.nodes().find(n => n.props['aria-label'] === 'Persona Engine');
  assert.equal(toggle?.props.disabled, true);
  assert.equal(toggle?.props['aria-checked'], false, 'stored mode must not appear active without the engine');
  toggle.props.onClick();
  const fileButtons = h.nodes().filter(n => n.type === 'button' && n.props.title?.startsWith?.('Delete '));
  assert.equal(fileButtons.length, 2);
  assert.ok(fileButtons.every(n => n.props.disabled));
  h.nav('Company Intel');
  const research = h.nodes().find(n => n.type === 'button' && n.children?.includes?.('Research Now'));
  assert.equal(research?.props.disabled, true);
  h.nav('Cover Letter');
  const generate = h.nodes().find(n => n.type === 'button' && JSON.stringify(n.children).includes('Generate Letter'));
  assert.equal(generate?.props.disabled, true);
  h.nav('Role Insight');
  assert.ok(h.nodes().some(n => n.children?.includes?.('Role Insight requires the Profile Intelligence knowledge engine.')));
  assert.deepEqual(h.calls, []);
});
