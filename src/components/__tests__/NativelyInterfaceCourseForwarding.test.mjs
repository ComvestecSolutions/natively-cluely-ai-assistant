import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { getCoursePinIds, setCoursePinIds, setCourseGroundingEnabled } from '../../lib/coursePins.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const chat = read('../NativelyInterface.tsx');
const parse = (source) => ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const ast = parse(chat);
const walk = (node, predicate, found = []) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, (child) => { walk(child, predicate, found); });
    return found;
};
const calls = (name) => walk(ast, (node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name);
const transpile = (text) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const owner = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isVariableDeclaration(parent)) return parent.name.getText(ast);
    }
};
const paths = [
    ...calls('startDirectAssist').map((node) => ({ name: 'DirectAssist', node, pinIndex: 0 })),
    ...calls('ragQueryLive').map((node) => ({ name: 'live RAG', node, pinIndex: 1 })),
    ...calls('streamGeminiChat').map((node, i) => ({ name: `Gemini fallback ${i + 1}`, node, pinIndex: 3 })),
];

test('reviewed bridge declarations use courseIds and all current dispatch expressions forward fresh pins', () => {
    assert.equal(calls('startDirectAssist').length, 1, 'one common dispatch covers all DirectAssist entry points');
    assert.equal(calls('ragQueryLive').length, 1);
    assert.equal(calls('streamGeminiChat').length, 2);
    assert.equal(paths.length, 4);
    for (const path of paths) {
        assert.match(path.node.arguments[path.pinIndex].getText(ast), /getCoursePinIds\(\)/, path.name);
    }
    assert.match(chat, /import \{ getCoursePinIds \} from '\.\.\/lib\/coursePins'/);
    for (const file of ['../../../electron/preload.ts', '../../types/electron.d.ts']) {
        const declarations = parse(read(file));
        const request = walk(declarations, (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'DirectAssistRequest')[0];
        assert.ok(request.members.some((member) => member.name?.getText(declarations) === 'courseIds' && member.questionToken));
        const api = walk(declarations, (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'ElectronAPI')[0];
        for (const [name, pinIndex] of [['ragQueryLive', 1], ['ragQueryMeeting', 2]]) {
            const property = api.members.find((member) => member.name?.getText(declarations) === name);
            const argument = property.type.parameters[pinIndex];
            assert.equal(argument.name.text, 'courseIds');
            assert.ok(argument.questionToken);
        }
    }
});

test('typed, screenshot and recorded answers route through the common DirectAssist dispatch', () => {
    const entries = walk(ast, (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'beginDirectAssist');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(owner).sort(), ['handleAnswerNow', 'handleManualSubmit', 'handleWhatToSay']);
    assert.equal(owner(calls('startDirectAssist')[0]), 'response');
    assert.match(calls('startDirectAssist')[0].arguments[0].getText(ast), /courseIds: getCoursePinIds\(\)/);
});

test('NativelyInterface currently has no meeting RAG call to patch; adding one must forward the third argument', () => {
    for (const node of calls('ragQueryMeeting')) {
        assert.equal(node.arguments.length, 3);
        assert.match(node.arguments[2].getText(ast), /getCoursePinIds\(\)/);
    }
    assert.equal(calls('ragQueryMeeting').length, 0);
});

// Execute the production candidate-selection/prompt builder with retrieval stubs,
// to test renderer dispatch against the backend's enabled-plus-pinned contract.
// No native database, provider request, or platform focus behavior is exercised.
const groundingAst = parse(read('../../../electron/courses/chatGrounding.ts'));
const groundingFunctions = walk(groundingAst, (node) => ts.isFunctionDeclaration(node)
    && ['buildCourseGroundedBlock', 'courseGroundingAsReference'].includes(node.name?.text));
const groundingCode = transpile(groundingFunctions.map((node) => node.getText(groundingAst)).join('\n'));
const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

for (const platform of ['darwin', 'win32']) {
    test(`${platform} simulated renderer: every path preserves on courses and excludes switched-off courses on the next request`, async () => {
        const courses = [
            { id: 'enabled', name: 'Enabled course', enabled: true },
            { id: 'legacy', name: 'Legacy pinned course', enabled: false },
            { id: 'off', name: 'Off course', enabled: false },
        ];
        const storage = new Map();
        globalThis.window = Object.assign(new EventTarget(), {
            localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
            electronAPI: { platform, coursesSetEnabled: async (id, enabled) => {
                const course = courses.find((item) => item.id === id);
                course.enabled = enabled;
                return { course };
            } },
        });
        setCoursePinIds(['legacy']);
        const exports = {};
        const searched = [];
        runInNewContext(groundingCode, {
            exports, console,
            GROUNDING_HEADER: 'Course context',
            COURSE_GROUNDED_TOKEN_BUDGET: 10000,
            estimateTokens: (text) => Math.ceil(text.length / 4),
            searchCourses: async (options) => { searched.push([...options.courseIds]); return []; },
        });
        const checkEveryPath = async (expectedIds) => {
            for (const path of paths) {
                let pinned;
                const api = Object.fromEntries(['startDirectAssist', 'ragQueryLive', 'streamGeminiChat'].map((name) => [name, async (...args) => {
                    const supplied = args[path.pinIndex];
                    pinned = [...(path.pinIndex === 1 ? supplied : supplied.courseIds)];
                    return { accepted: true, success: true };
                }]));
                await runInNewContext(transpile(`(async () => ${path.node.getText(ast)})()`), {
                    window: { electronAPI: api }, getCoursePinIds,
                    requestId: 'request-1', source: 'typed', currentRequest: 'Keep this instruction unchanged',
                    directAssistSkillId: () => undefined, directAssistHistoryRef: { current: [] },
                    directPageContext: undefined, imagePaths: [], transcript: undefined,
                    question: 'Spoken question', userText: 'Typed question', currentAttachments: [],
                    prompt: 'Existing prompt', conversationContextForSubmit: 'Existing context',
                });
                assert.deepEqual(pinned, getCoursePinIds(), `${path.name}: dispatch-time pins`);
                searched.length = 0;
                const block = await exports.buildCourseGroundedBlock({
                    message: 'Question', pinnedCourseIds: pinned, storeLike: { listCourses: () => courses }, db: {},
                });
                if (expectedIds.length) {
                    assert.deepEqual(searched[0], expectedIds, `${path.name}: active courses`);
                    assert.ok(block);
                } else {
                    assert.equal(block, null, `${path.name}: all-off excludes grounding`);
                    assert.equal(searched.length, 0);
                }
            }
        };
        await checkEveryPath(['legacy', 'enabled']);
        await setCourseGroundingEnabled('legacy', false);
        await checkEveryPath(['enabled']);
        await setCourseGroundingEnabled('enabled', false);
        await checkEveryPath([]);
        await setCourseGroundingEnabled('enabled', true);
        await checkEveryPath(['enabled']);
    });
}
