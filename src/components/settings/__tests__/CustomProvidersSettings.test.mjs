import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../AIProvidersSettings.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('AIProvidersSettings.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sections = [];
function visit(node) {
    if (ts.isJsxElement(node)) {
        const text = node.getText(parsed);
        if (text.includes('onClick={handleNewProvider}') && text.includes('onClick={() => handleDeleteCustom(provider.id)}')) sections.push(text);
    }
    ts.forEachChild(node, visit);
}
visit(parsed);
const section = sections.sort((a, b) => a.length - b.length)[0];
assert.ok(section, 'find the actual Custom Providers section');
const states = source.slice(source.indexOf('// --- Custom Providers ---'), source.indexOf('// --- Local (Ollama) ---'));
const handlers = source.slice(source.indexOf('// --- Custom Provider Handlers ---'), source.indexOf('// Copy + action for whatever destructive request'));
// Run only the real Custom Providers hooks, handlers, and JSX. Unrelated provider
// effects and native Electron APIs are deliberately outside this renderer seam.
const compiled = ts.transpileModule(`function Component() {
    ${states}
    const [pendingConfirm, setPendingConfirm] = useState(null);
    ${handlers}
    return { ui: (${section}), pendingConfirm, handleNewProvider, handleEditProvider,
        handleSaveCustom, handleDeleteCustom, performDeleteCustom };
}
module.exports = Component;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

const curl = 'curl http://localhost:1234/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"local-model","messages":[{"role":"user","content":"{{TEXT}}"}]}\'';
const provider = { id: 'existing', name: 'Local model', curlCommand: curl, responsePath: 'choices[0].message.content' };
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness(platform = 'win32') {
    const slots = [];
    const writes = [];
    const deletes = [];
    let cursor = 0;
    let uuid = 0;
    let output;
    let providers = [];
    const hooks = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState(initial) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
            return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
        },
        useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    };
    const api = {
        saveCustomProvider: async (value) => {
            writes.push(value);
            providers = [value, ...providers.filter((p) => p.id !== value.id)];
            return { success: true };
        },
        deleteCustomProvider: async (id) => {
            deletes.push(id);
            providers = providers.filter((p) => p.id !== id);
            return { success: true };
        },
        getCustomProviders: async () => providers,
    };
    const module = { exports: {} };
    const context = {
        module, React: hooks, ...hooks, t: (s) => s, Error, console,
        crypto: { randomUUID: () => `draft-${++uuid}` },
        window: { electronAPI: api }, process: { platform },
        validateCurl: () => ({ isValid: true }),
        disabledProviders: [], handleToggleProvider() {},
    };
    for (const name of ['AipBadge', 'AipSwitch', 'AipSelect', 'AipMonogram', 'Plus', 'Save', 'Loader2', 'AlertCircle', 'Edit2', 'Trash2']) context[name] = name;
    runInNewContext(compiled, context, { filename: 'CustomProvidersSettings.js' });
    function render() { cursor = 0; output = module.exports(); return output; }
    function nodes() {
        const all = [];
        const walk = (node) => {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            all.push(node);
            node.children?.forEach(walk);
        };
        walk(output.ui);
        return all;
    }
    const text = (node = output.ui) => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.children || []) : typeof node === 'string' ? node : '';
    const button = (label) => nodes().find((n) => n.type === 'button' && text(n).includes(label));
    function draft(value = provider) {
        output.handleEditProvider(value);
        render();
    }
    function newDraft() {
        output.handleNewProvider(); render();
        const inputs = nodes().filter((n) => n.type === 'input');
        inputs[0].props.onChange({ target: { value: provider.name } });
        nodes().find((n) => n.type === 'textarea').props.onChange({ target: { value: curl } });
        render();
    }
    render();
    return { api, context, writes, deletes, render, nodes, text, button, draft, newDraft,
        get output() { return output; },
        get editing() { return nodes().some((n) => n.type === 'textarea'); },
        setProviders(value) { providers = value; },
    };
}

for (const platform of ['darwin', 'win32']) {
    test(`${platform}: save blocks rapid duplicate submissions and disables conflicting editor actions`, async () => {
        const h = harness(platform);
        h.newDraft();
        const pending = deferred();
        h.api.saveCustomProvider = (value) => { h.writes.push(value); h.setProviders([value]); return pending.promise; };
        const save = h.button('Save Provider').props.onClick;
        const first = save();
        const second = save();
        h.render();
        assert.equal(h.writes.length, 1);
        assert.equal(h.button('Cancel').props.disabled, true);
        assert.ok(h.nodes().some((n) => n.type === 'button' && n.props.disabled && h.text(n).includes('Saving')));
        assert.ok(h.nodes().find((n) => n.type === 'textarea').props.disabled);
        pending.resolve({ success: true });
        await Promise.all([first, second]); h.render();
        assert.equal(h.editing, false);
    });

    test(`${platform}: explicit credential rejection retains the draft with actionable copy`, async () => {
        const h = harness(platform); h.draft();
        h.api.saveCustomProvider = async () => ({ success: false, error: 'credential_store_degraded' });
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.editing, true);
        assert.match(h.text(), /credential store is unavailable.*Restart Natively/);
        assert.equal(h.button('Save Provider').props.disabled, false);
        assert.equal(h.nodes().find((n) => n.type === 'textarea').props.value, curl);
    });

    test(`${platform}: silent refused save does not close the editor after IPC reports success`, async () => {
        const h = harness(platform); h.newDraft();
        h.api.saveCustomProvider = async () => ({ success: true });
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.editing, true);
        assert.match(h.text(), /Could not confirm.*saved/);
    });

    test(`${platform}: delete rejection and silent no-op preserve the list and display errors`, async () => {
        for (const result of [{ success: false, error: 'credential_store_degraded' }, { success: true }, undefined]) {
            const h = harness(platform); h.setProviders([provider]); h.draft();
            await h.output.handleSaveCustom(); h.render();
            h.api.deleteCustomProvider = async () => result;
            h.output.handleDeleteCustom(provider.id); h.render();
            assert.equal(h.output.pendingConfirm.id, provider.id);
            await h.output.performDeleteCustom(provider.id); h.render();
            assert.ok(h.text().includes(provider.name));
            assert.ok(h.nodes().some((n) => n.props.role === 'alert'));
        }
    });

    test(`${platform}: delete blocks duplicate mutations and disables row/add actions`, async () => {
        const h = harness(platform); h.draft(); await h.output.handleSaveCustom(); h.render();
        const pending = deferred();
        h.api.deleteCustomProvider = (id) => { h.deletes.push(id); return pending.promise; };
        const remove = h.output.performDeleteCustom;
        const first = remove(provider.id);
        const second = remove(provider.id); h.render();
        assert.equal(h.deletes.length, 1);
        assert.equal(h.button('Add Provider').props.disabled, true);
        assert.ok(h.nodes().filter((n) => ['Edit', 'Delete'].includes(n.props.title)).every((n) => n.props.disabled));
        h.setProviders([]); pending.resolve({ success: true });
        await Promise.all([first, second]); h.render();
        assert.match(h.text(), /No custom providers added yet/);
        assert.equal(h.button('Add Provider').props.disabled, false);
    });
}

test('validation failures, including thrown values, are caught and leave the editor usable', async () => {
    for (const validate of [() => ({ isValid: false, message: 'Invalid template' }), () => { throw new Error('Parser failed'); }, () => { throw null; }]) {
        const h = harness(); h.draft(); h.context.validateCurl = validate;
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.writes.length, 0);
        assert.equal(h.editing, true);
        assert.ok(h.nodes().some((n) => n.props.role === 'alert'));
        assert.equal(h.button('Save Provider').props.disabled, false);
    }
});

test('empty names are rejected before validation or IPC', async () => {
    const h = harness(); h.draft({ ...provider, name: '   ' });
    h.context.validateCurl = () => { assert.fail('must not validate unnamed provider'); };
    await h.output.handleSaveCustom(); h.render();
    assert.match(h.text(), /Provider Name is required/);
    assert.equal(h.writes.length, 0);
});

test('missing or failed save responses have nonempty errors and retain the draft', async () => {
    for (const result of [undefined, null, { success: false }, { success: false, error: '' }, { success: false, message: 'Persistence refused' }]) {
        const h = harness(); h.draft(); h.api.saveCustomProvider = async () => result;
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.editing, true);
        assert.ok(h.nodes().some((n) => n.props.role === 'alert'));
        if (result?.message) assert.match(h.text(), /Persistence refused/);
    }
});

test('save and refresh exceptions retain the draft; retry reuses the new provider ID', async () => {
    const h = harness(); h.newDraft();
    const originalRead = h.api.getCustomProviders;
    h.api.getCustomProviders = async () => { throw new Error('Refresh failed'); };
    await h.output.handleSaveCustom(); h.render();
    assert.equal(h.editing, true);
    assert.match(h.text(), /Refresh failed/);
    h.api.getCustomProviders = originalRead;
    await h.output.handleSaveCustom(); h.render();
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[0].id, h.writes[1].id);
    assert.equal(h.editing, false);
    for (const error of [new Error('Save failed'), null]) {
        h.draft(); h.api.saveCustomProvider = async () => { throw error; };
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.editing, true);
        assert.ok(h.nodes().some((n) => n.props.role === 'alert'));
        assert.equal(h.button('Save Provider').props.disabled, false);
    }
});

test('save preserves explicit vision modes and omits the flag for auto-detect', async () => {
    for (const [mode, expected] of [['auto', undefined], ['on', true], ['off', false]]) {
        const h = harness(); h.draft();
        h.nodes().find((n) => n.type === 'AipSelect').props.onChange(mode); h.render();
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.writes[0].multimodal, expected);
        assert.equal(Object.hasOwn(h.writes[0], 'multimodal'), mode !== 'auto');
        assert.equal(h.editing, false);
    }
});

test('read-back must match edited fields, including vision mode, before closing', async () => {
    for (const changed of [{ name: 'Old name' }, { curlCommand: 'old curl' }, { responsePath: 'old.path' }, { multimodal: true }]) {
        const h = harness(); h.draft();
        h.api.getCustomProviders = async () => [{ ...provider, ...changed }];
        await h.output.handleSaveCustom(); h.render();
        assert.equal(h.editing, true);
        assert.match(h.text(), /Could not confirm.*saved/);
    }
});

test('delete exceptions and invalid refresh results remain visible outside the editor', async () => {
    for (const fail of ['delete', 'refresh', 'invalid']) {
        const h = harness(); h.draft(); await h.output.handleSaveCustom(); h.render();
        if (fail === 'delete') h.api.deleteCustomProvider = async () => { throw new Error('Delete failed'); };
        if (fail === 'refresh') h.api.getCustomProviders = async () => { throw new Error('Refresh failed'); };
        if (fail === 'invalid') h.api.getCustomProviders = async () => null;
        await h.output.performDeleteCustom(provider.id); h.render();
        assert.equal(h.editing, false);
        assert.ok(h.nodes().some((n) => n.props.role === 'alert'));
        assert.equal(h.button('Add Provider').props.disabled, false);
    }
});

test('saved command preview masks credentials completely, while intentional editor contents are unchanged', async () => {
    for (const secretCurl of [
        'curl -u private-user:private-password https://host.test -d "{{TEXT}}"',
        'curl -H "Authorization: Bearer private-token" https://host.test -d "{{TEXT}}"',
        'curl https://private-user:private-password@host.test?api_key=private-key -d "{{TEXT}}"',
    ]) {
        const h = harness(); h.draft({ ...provider, curlCommand: secretCurl });
        assert.equal(h.nodes().find((n) => n.type === 'textarea').props.value, secretCurl);
        await h.output.handleSaveCustom(); h.render();
        assert.doesNotMatch(JSON.stringify(h.output.ui), /private-(user|password|token|key)/);
        assert.match(h.text(), /cURL.*hidden/);
    }
});

test('copy describes local LM Studio and OpenAI-compatible cURL without status claims', () => {
    const h = harness();
    assert.match(h.text(), /LM Studio/);
    assert.match(h.text(), /OpenAI-compatible.*cURL/);
    assert.doesNotMatch(h.text(), /Experimental|Verified|Stable/);
    h.newDraft();
    assert.match(h.text(), /localhost:1234\/v1\/chat\/completions/);
    assert.match(h.text(), /\{\{TEXT\}\}/);
    assert.match(h.text(), /Leave empty to auto-detect common formats/);
    assert.doesNotMatch(h.text(), /If empty, the full JSON is returned/);
});
