import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import type {
  FileData,
  FileEntry,
  ModelSettings,
  Session,
  Task,
  TaskEvent,
  Workspace,
} from './types';

const finished = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'budget_exhausted',
  'rejected',
]);
const labels: Record<string, string> = {
  queued: '等待执行',
  running: '正在处理',
  waiting_review: '等待审阅',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
  budget_exhausted: '达到预算',
  rejected: '已拒绝',
};
const patchLabels: Record<string, string> = {
  proposed: '待审阅',
  applied: '已应用',
  rejected: '已拒绝',
  reverted: '已撤销',
  recovery_required: '需要恢复',
  conflicted: '文件冲突',
};
const call = <T,>(method: string, path: string, body?: unknown) =>
  window.codeAssistant.request<T>(method, path, body);
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );
const language = (path: string) =>
  ({
    py: 'python',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
    ps1: 'powershell',
    sh: 'shell',
    toml: 'ini',
    sql: 'sql',
    rs: 'rust',
    go: 'go',
  })[path.split('.').pop()!.toLowerCase()] || 'plaintext';
const options = {
  fontSize: 14,
  lineHeight: 23,
  fontFamily: 'Cascadia Code, Consolas, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  padding: { top: 18 },
  wordWrap: 'on' as const,
};

function Tree({
  workspace,
  path = '',
  depth = 0,
  openFile,
  report,
}: {
  workspace: Workspace;
  path?: string;
  depth?: number;
  openFile: (path: string) => void;
  report: (error: unknown) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let current = true;
    call<FileEntry[]>(
      'GET',
      `/api/workspaces/${workspace.id}/tree?path=${encodeURIComponent(path)}`,
    )
      .then((value) => {
        if (current) setEntries(value);
      })
      .catch(report);
    return () => {
      current = false;
    };
  }, [workspace.id, path, report]);
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            className="tree-entry"
            style={{ paddingLeft: 16 + depth * 14 }}
            title={entry.path}
            onClick={() => {
              if (!entry.directory) return openFile(entry.path);
              setExpanded((previous) => {
                const next = new Set(previous);
                next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
                return next;
              });
            }}
          >
            <span className={entry.directory ? 'folder-icon' : 'file-icon'}>
              {entry.directory ? (expanded.has(entry.path) ? '▾' : '▸') : '·'}
            </span>
            <span>{entry.name}</span>
          </button>
          {entry.directory && expanded.has(entry.path) && (
            <Tree
              workspace={workspace}
              path={entry.path}
              depth={depth + 1}
              openFile={openFile}
              report={report}
            />
          )}
        </div>
      ))}
    </>
  );
}

function SettingsDialog({
  settings,
  close,
  saved,
}: {
  settings: ModelSettings;
  close: () => void;
  saved: (value: ModelSettings) => void;
}) {
  const [form, setForm] = useState({ ...settings, api_key: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (key: string, value: string | number) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <div
      className="modal-shade"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="settings-dialog"
        aria-label="模型设置"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            saved(await call<ModelSettings>('PUT', '/api/settings', form));
            close();
          } catch (error) {
            setError(message(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">MODEL CONNECTION</div>
            <h2>连接你的模型</h2>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭模型设置">
            ×
          </button>
        </div>
        <p className="muted">支持提供兼容 API 的云端服务与本地模型。配置保存在当前电脑。</p>
        <label>
          API 地址
          <input
            required
            name="base_url"
            value={form.base_url}
            onChange={(event) => update('base_url', event.target.value)}
            placeholder="https://你的模型服务/v1"
          />
        </label>
        <label>
          模型名称
          <input
            required
            name="model"
            value={form.model}
            onChange={(event) => update('model', event.target.value)}
            placeholder="填写服务商提供的模型 ID"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            name="api_key"
            value={form.api_key}
            onChange={(event) => update('api_key', event.target.value)}
            autoComplete="off"
            placeholder={settings.has_api_key ? '已设置，留空保留现有密钥' : '本地无鉴权服务可留空'}
          />
        </label>
        <div className="form-row">
          <label>
            每个任务最多调用
            <input
              type="number"
              min="1"
              max="30"
              value={form.max_steps}
              onChange={(event) => update('max_steps', Number(event.target.value))}
            />
          </label>
          <label>
            执行时间上限（秒）
            <input
              type="number"
              min="30"
              max="1800"
              value={form.task_timeout}
              onChange={(event) => update('task_timeout', Number(event.target.value))}
            />
          </label>
        </div>
        <p className="hint">
          {settings.key_storage === 'memory'
            ? '当前密钥仅在本次服务会话中保存，重启后需重新填写。'
            : '密钥优先存入系统凭据库；环境不支持时仅保存在内存。'}
        </p>
        {error && (
          <div className="error-inline" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存连接'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [file, setFile] = useState<FileData | null>(null);
  const [savedContent, setSavedContent] = useState('');
  const [view, setView] = useState<'editor' | 'diff'>('editor');
  const [patchId, setPatchId] = useState('');
  const [changeIndex, setChangeIndex] = useState(0);
  const [activity, setActivity] = useState<TaskEvent[]>([]);
  const [logs, setLogs] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [testEnabled, setTestEnabled] = useState(false);
  const [testCommand, setTestCommand] = useState('python -m pytest -q');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ path: string; line: number; text: string }[] | null>(
    null,
  );
  const [treeVersion, setTreeVersion] = useState(0);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const dirty = !!file && file.content !== savedContent;
  const report = useCallback((error: unknown) => setError(message(error)), []);
  const busy = !!task && !finished.has(task.status);
  const patch = task?.patches?.find((item) => item.id === patchId) || task?.patches?.at(-1);
  const change = patch?.changes[changeIndex] || patch?.changes[0];

  useEffect(() => {
    if (!window.codeAssistant) {
      setError('请通过桌面启动命令运行此客户端。');
      setBooting(false);
      return;
    }
    window.codeAssistant
      .bootstrap()
      .then((value) => {
        setSettings(value.settings);
        setWorkspaces(value.workspaces);
        setWorkspace(value.workspaces[0] || null);
      })
      .catch(report)
      .finally(() => setBooting(false));
  }, [report]);

  const refreshTask = useCallback(async (id: string) => {
    const updated = await call<Task>('GET', `/api/tasks/${id}`);
    setTask((previous) => (previous?.id === id ? updated : previous));
    setTasks((previous) => previous.map((item) => (item.id === id ? updated : item)));
  }, []);

  useEffect(() => {
    const id = task?.id;
    if (!id) return;
    setActivity([]);
    setLogs('');
    const seen = new Set<number>();
    const remove = window.codeAssistant.onEvent((event) => {
      if (event.task_id !== id || (event.id !== undefined && seen.has(event.id))) return;
      if (event.id !== undefined) seen.add(event.id);
      if (event.kind === 'model.delta') return;
      if (event.kind === 'command.output') {
        setLogs((previous) => (previous + (event.data.text || '')).slice(-200000));
        return;
      }
      setActivity((previous) => [...previous.slice(-39), event]);
      if (event.kind === 'agent.step')
        setTask((previous) =>
          previous?.id === id ? { ...previous, steps: event.data.step || 0 } : previous,
        );
      if (event.kind === 'patch.proposed') {
        setPatchId(event.data.patch_id || '');
        setChangeIndex(0);
        setView('diff');
      }
      if (event.kind === 'patch.applied' || event.kind === 'patch.reverted')
        setTreeVersion((previous) => previous + 1);
      if (
        event.kind.startsWith('task.') ||
        event.kind.startsWith('patch.') ||
        event.kind === 'command.completed'
      )
        void refreshTask(id).catch(report);
      if (event.kind === 'connection.error') setError(event.data.message || '事件流连接中断。');
    });
    void window.codeAssistant.watchTask(id).catch(report);
    return () => {
      remove();
      void window.codeAssistant.unwatchTask(id).catch(() => {});
    };
  }, [task?.id, refreshTask, report]);

  useEffect(() => {
    setSessionId(null);
    setTasks([]);
    setTask(null);
    setFile(null);
    setResults(null);
    setSearch('');
    setView('editor');
    if (!workspace) {
      setSessions([]);
      return;
    }
    let valid = true;
    call<Session[]>('GET', `/api/sessions?workspace_id=${workspace.id}`)
      .then((value) => {
        if (valid) setSessions(value);
      })
      .catch(report);
    return () => {
      valid = false;
    };
  }, [workspace?.id, report]);

  const saveFile = useCallback(async () => {
    if (!workspace || !file || !dirty) return;
    try {
      const saved = await call<FileData>('PUT', `/api/workspaces/${workspace.id}/file`, {
        path: file.path,
        content: file.content,
        base_hash: file.hash,
      });
      setFile(saved);
      setSavedContent(saved.content);
      setError('');
    } catch (error) {
      report(error);
    }
  }, [workspace, file, dirty, report]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveFile();
      }
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [saveFile]);

  async function openWorkspace() {
    if (dirty && !window.confirm('当前文件有未保存修改，是否放弃这些修改并切换项目？')) return;
    try {
      const selected = await window.codeAssistant.openWorkspace();
      if (selected) {
        setWorkspaces((previous) => [
          ...previous.filter((item) => item.id !== selected.id),
          selected,
        ]);
        setWorkspace(selected);
      }
    } catch (error) {
      report(error);
    }
  }
  async function openFile(path: string) {
    if (!workspace) return;
    if (dirty && !window.confirm('当前文件有未保存修改，是否放弃并打开另一个文件？')) return;
    try {
      const loaded = await call<FileData>(
        'GET',
        `/api/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}`,
      );
      setFile(loaded);
      setSavedContent(loaded.content);
      setView('editor');
      setError('');
    } catch (error) {
      report(error);
    }
  }
  async function loadSession(id: string) {
    try {
      const loaded = await call<Task[]>('GET', `/api/sessions/${id}/tasks`);
      setSessionId(id);
      setTasks(loaded);
      setPatchId('');
      setView('editor');
      setTask(loaded.length ? await call<Task>('GET', `/api/tasks/${loaded.at(-1)!.id}`) : null);
    } catch (error) {
      report(error);
    }
  }
  async function submit() {
    if (!workspace || !prompt.trim() || sending || busy) return;
    if (dirty) {
      setError('请先保存当前文件，再把最新代码交给助手。');
      return;
    }
    setSending(true);
    setError('');
    try {
      const argv = testEnabled ? testCommand.trim().split(/\s+/) : [];
      const created = await call<Task>('POST', '/api/tasks', {
        workspace_id: workspace.id,
        session_id: sessionId,
        prompt: prompt.trim(),
        selected_file: file?.path || null,
        test_argv: argv,
      });
      setTask(created);
      setTasks((previous) => [...previous, created]);
      setSessionId(created.session_id);
      setPrompt('');
      setPatchId('');
      setSessions(await call<Session[]>('GET', `/api/sessions?workspace_id=${workspace.id}`));
    } catch (error) {
      report(error);
    } finally {
      setSending(false);
    }
  }
  async function review(accept: boolean) {
    if (!patch) return;
    if (dirty) {
      setError('请先保存或放弃编辑器中的修改，再应用补丁。');
      return;
    }
    try {
      await call('POST', `/api/patches/${patch.id}/review`, { accept });
      await refreshTask(task!.id);
      if (accept && file) {
        if (patch.changes.some((change) => change.path === file.path && change.after === null))
          setFile(null);
        else {
          const updated = await call<FileData>(
            'GET',
            `/api/workspaces/${workspace!.id}/file?path=${encodeURIComponent(file.path)}`,
          );
          setFile(updated);
          setSavedContent(updated.content);
        }
      }
    } catch (error) {
      report(error);
    }
  }
  async function undo() {
    if (!patch || dirty) {
      if (dirty) setError('请先保存或放弃当前编辑内容。');
      return;
    }
    try {
      await call('POST', `/api/patches/${patch.id}/undo`, {});
      await refreshTask(task!.id);
      setTreeVersion((previous) => previous + 1);
      if (file) {
        if (patch.changes.some((change) => change.path === file.path && change.before === null))
          setFile(null);
        else await openFile(file.path);
      }
    } catch (error) {
      report(error);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">CA</span>
          <strong>
            CodeAssistant<span>Agent</span>
          </strong>
          <span className="version">0.1</span>
        </div>
        <div className="header-workspace">
          <span className="status-light" />
          {booting ? '连接本地服务…' : workspace?.name || '尚未打开项目'}
          {workspaces.length > 1 && (
            <select
              aria-label="切换工作区"
              value={workspace?.id || ''}
              onChange={(event) => {
                if (!dirty || window.confirm('放弃未保存的修改并切换？'))
                  setWorkspace(workspaces.find((item) => item.id === event.target.value) || null);
              }}
            >
              {workspaces.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="header-actions">
          <button className="secondary" onClick={openWorkspace}>
            ＋ 打开项目
          </button>
          <button
            className="model-button"
            onClick={() => setSettingsOpen(true)}
            disabled={!settings}
          >
            <span className={settings?.model ? 'model-dot' : 'model-dot pending'} />
            {settings?.model || '设置模型'}
          </button>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button aria-label="关闭错误提示" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      <div className="workspace-layout">
        <aside className="sidebar">
          <div className="section-header">
            <span>项目文件</span>
            <button
              className="icon-button"
              aria-label="刷新文件树"
              onClick={() => setTreeVersion((previous) => previous + 1)}
            >
              ↻
            </button>
          </div>
          {workspace && (
            <form
              className="search-box"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!search.trim()) {
                  setResults(null);
                  return;
                }
                try {
                  setResults(
                    await call(
                      'GET',
                      `/api/workspaces/${workspace.id}/search?query=${encodeURIComponent(search)}`,
                    ),
                  );
                } catch (error) {
                  report(error);
                }
              }}
            >
              <input
                aria-label="搜索项目代码"
                placeholder="搜索代码，Enter 确认"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (!event.target.value) setResults(null);
                }}
              />
            </form>
          )}
          <div className="file-tree">
            {workspace ? (
              results ? (
                <>
                  <button
                    className="text-button search-back"
                    onClick={() => {
                      setResults(null);
                      setSearch('');
                    }}
                  >
                    ← 返回文件树 · {results.length} 条结果
                  </button>
                  {results.map((result, index) => (
                    <button
                      className="search-result"
                      key={`${result.path}:${result.line}:${index}`}
                      onClick={() => void openFile(result.path)}
                    >
                      <strong>
                        {result.path}:{result.line}
                      </strong>
                      <span>{result.text}</span>
                    </button>
                  ))}
                  {!results.length && <p className="empty-small">没有找到匹配内容。</p>}
                </>
              ) : (
                <Tree
                  key={`${workspace.id}:${treeVersion}`}
                  workspace={workspace}
                  openFile={(path) => void openFile(path)}
                  report={report}
                />
              )
            ) : (
              <div className="empty-small">打开项目后，这里会显示真实的目录与文件。</div>
            )}
          </div>
          <div className="section-header history-header">
            <span>会话记录</span>
            <span className="subtle-count">{sessions.length}</span>
          </div>
          <div className="sessions">
            {sessions.map((session) => (
              <button
                className={`session-entry ${session.id === sessionId ? 'selected' : ''}`}
                key={session.id}
                onClick={() => void loadSession(session.id)}
                title={session.title}
              >
                {session.title}
              </button>
            ))}
            {!sessions.length && <p className="empty-small">任务与会话会保存在本机。</p>}
          </div>
          <footer className="sidebar-footer" title={workspace?.root}>
            {workspace?.root || '本地工作区'}
            <span>{settings ? '本地服务已连接' : '等待本地服务连接'}</span>
          </footer>
        </aside>

        <main className="editor-area">
          <div className="editor-tabs">
            <button className={view === 'editor' ? 'active' : ''} onClick={() => setView('editor')}>
              {file ? file.path.split('/').pop() : '工作台'}
              {dirty && <span className="dirty-dot">●</span>}
            </button>
            {patch && (
              <button className={view === 'diff' ? 'active' : ''} onClick={() => setView('diff')}>
                修改审阅 <span className="count-badge">{patch.changes.length}</span>
              </button>
            )}
            <div className="tab-spacer" />
            {file && view === 'editor' && (
              <button className="save-button" disabled={!dirty} onClick={() => void saveFile()}>
                保存 <kbd>Ctrl S</kbd>
              </button>
            )}
          </div>
          {view === 'diff' && patch && change ? (
            <>
              <div className="diff-toolbar">
                <div>
                  <select
                    aria-label="选择补丁"
                    value={patch.id}
                    onChange={(event) => {
                      setPatchId(event.target.value);
                      setChangeIndex(0);
                    }}
                  >
                    {task?.patches?.map((item, index) => (
                      <option value={item.id} key={item.id}>
                        补丁 {index + 1} · {patchLabels[item.status] || item.status}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="选择变更文件"
                    value={changeIndex}
                    onChange={(event) => setChangeIndex(Number(event.target.value))}
                  >
                    {patch.changes.map((item, index) => (
                      <option value={index} key={item.path}>
                        {item.path}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="review-actions">
                  {patch.status === 'proposed' ? (
                    <>
                      <button className="secondary" onClick={() => void review(false)}>
                        拒绝
                      </button>
                      <button className="primary" onClick={() => void review(true)}>
                        接受并应用
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="muted">{patchLabels[patch.status] || patch.status}</span>
                      {['applied', 'recovery_required'].includes(patch.status) && (
                        <button className="secondary" disabled={busy} onClick={() => void undo()}>
                          撤销此补丁
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="diff-labels">
                <span>修改前</span>
                <span>修改后</span>
              </div>
              <div className="monaco-container">
                <DiffEditor
                  original={change.before || ''}
                  modified={change.after || ''}
                  language={language(change.path)}
                  originalModelPath={`${patch.id}/before/${change.path}`}
                  modifiedModelPath={`${patch.id}/after/${change.path}`}
                  theme="assistant-dark"
                  options={{
                    ...options,
                    readOnly: true,
                    renderSideBySide: true,
                    enableSplitViewResizing: true,
                  }}
                />
              </div>
            </>
          ) : file ? (
            <>
              <div className="file-breadcrumb">
                {workspace?.name}
                <span>/</span>
                {file.path}
                <span className="tab-spacer" />
                UTF-8
              </div>
              <div className="monaco-container">
                <Editor
                  path={`${workspace?.id}/${file.path}`}
                  value={file.content}
                  language={language(file.path)}
                  theme="assistant-dark"
                  options={options}
                  onMount={(editor) => {
                    editorRef.current = editor;
                  }}
                  onChange={(value) =>
                    setFile((previous) => (previous ? { ...previous, content: value || '' } : null))
                  }
                />
              </div>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-mark">CA</div>
              <div className="eyebrow">YOUR LOCAL CODING WORKSPACE</div>
              <h1>{workspace ? '选择文件，或交给助手一个任务' : '打开项目，开始处理代码'}</h1>
              <p>
                在真实代码上检索、审阅修改并验证结果。
                <br />
                每一次补丁都能查看差异，再决定是否应用。
              </p>
              <div className="welcome-actions">
                <button className="primary" onClick={openWorkspace}>
                  打开项目文件夹
                </button>
                <button
                  className="secondary"
                  onClick={() => setSettingsOpen(true)}
                  disabled={!settings}
                >
                  配置模型连接
                </button>
              </div>
              <div className="workflow-hint">
                <span>01 读取代码</span>
                <i>→</i>
                <span>02 审阅修改</span>
                <i>→</i>
                <span>03 运行验证</span>
              </div>
            </div>
          )}
          <div className="terminal-heading">
            <button onClick={() => setLogsOpen((previous) => !previous)}>
              {logsOpen ? '▾' : '▸'} 运行输出{logs && <span className="model-dot" />}
            </button>
            <span>测试命令由当前任务授权</span>
          </div>
          {logsOpen && (
            <pre className="terminal-output">
              {logs || '测试或构建执行后，这里会显示真实输出与退出信息。'}
            </pre>
          )}
        </main>

        <aside className="assistant-panel">
          <div className="assistant-header">
            <div>
              <span className="assistant-spark">✦</span>
              <strong>代码助手</strong>
            </div>
            <button
              className="text-button"
              onClick={() => {
                setSessionId(null);
                setTasks([]);
                setTask(null);
                setPatchId('');
              }}
            >
              ＋ 新会话
            </button>
          </div>
          <div className="chat-content">
            {!tasks.length && (
              <div className="assistant-intro">
                <div className="eyebrow">从一个具体问题开始</div>
                <h3>今天想完成什么？</h3>
                <p>可以解释选中的文件、查找实现位置，或提出一项需要修复的行为。</p>
                <button
                  onClick={() => setPrompt('介绍这个项目的入口和主要模块，并给出相关文件依据。')}
                >
                  了解项目结构 <span>↗</span>
                </button>
                <button
                  onClick={() =>
                    setPrompt('解释当前文件的主要职责、调用关系和需要关注的边界情况。')
                  }
                >
                  解释当前文件 <span>↗</span>
                </button>
              </div>
            )}
            {tasks.map((item) => (
              <div
                className={`conversation ${item.id === task?.id ? 'current' : ''}`}
                key={item.id}
              >
                <button
                  className="user-message"
                  onClick={() => {
                    void call<Task>('GET', `/api/tasks/${item.id}`)
                      .then((value) => {
                        setTask(value);
                        setPatchId('');
                      })
                      .catch(report);
                  }}
                >
                  <span className="message-label">你</span>
                  {item.prompt}
                </button>
                <div className="assistant-message">
                  <div className="message-label">
                    代码助手{' '}
                    <span className={`task-status ${item.status}`}>
                      {labels[item.status] || item.status}
                    </span>
                  </div>
                  {item.result ? (
                    <div className="answer-text">{item.result}</div>
                  ) : (
                    <div className="muted">
                      {item.status === 'waiting_review'
                        ? '补丁已准备好，请在修改审阅中确认。'
                        : '任务进行中，可查看下方活动记录。'}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {task && (
              <div className="activity-panel">
                <div className="activity-heading">
                  <span>执行活动</span>
                  <span>
                    {task.steps} / {settings?.max_steps || 12} 步
                  </span>
                </div>
                {activity
                  .filter((item) => item.kind !== 'task.queued')
                  .slice(-12)
                  .map((item, index) => (
                    <div
                      className={`activity-entry ${item.kind.includes('error') || item.kind.includes('failed') ? 'activity-error' : ''}`}
                      key={item.id || index}
                    >
                      <span className="activity-dot" />
                      <span>
                        {item.data.message ||
                          (item.kind === 'command.completed'
                            ? `测试退出码：${item.data.exit_code ?? '超时'}`
                            : item.kind === 'patch.rejected'
                              ? '本次补丁已拒绝。'
                              : item.kind)}
                      </span>
                    </div>
                  ))}
                {task.status === 'waiting_review' && (
                  <button className="review-link" onClick={() => setView('diff')}>
                    打开修改审阅 →
                  </button>
                )}
                {busy && (
                  <button
                    className="cancel-task"
                    onClick={() =>
                      void call('POST', `/api/tasks/${task.id}/cancel`, {})
                        .then(() => refreshTask(task.id))
                        .catch(report)
                    }
                  >
                    停止当前任务
                  </button>
                )}
              </div>
            )}
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="composer-context">
              {file ? (
                <span title={file.path}>
                  ▧ {file.path.split('/').pop()}
                  {dirty ? ' · 未保存' : ''}
                </span>
              ) : (
                <span>使用当前项目上下文</span>
              )}
            </div>
            <textarea
              aria-label="任务需求"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={workspace ? '描述一个问题或开发任务…' : '先打开项目，再开始提问'}
              disabled={!workspace}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <label className="test-toggle">
              <input
                type="checkbox"
                checked={testEnabled}
                onChange={(event) => setTestEnabled(event.target.checked)}
              />
              允许此任务运行测试
            </label>
            {testEnabled && (
              <input
                className="test-command"
                aria-label="授权测试命令"
                value={testCommand}
                onChange={(event) => setTestCommand(event.target.value)}
                spellCheck={false}
              />
            )}
            <div className="composer-bottom">
              <span>
                {!settings?.model
                  ? '先在右上角连接模型'
                  : busy
                    ? '当前会话有未完成任务'
                    : 'Ctrl + Enter 发送'}
              </span>
              <button
                className="primary"
                disabled={!workspace || !prompt.trim() || busy || sending || !settings?.model}
                type="submit"
              >
                {sending ? '提交中…' : '发送 ↑'}
              </button>
            </div>
          </form>
        </aside>
      </div>
      <footer className="app-status">
        <span>
          <i />
          本地工作区 · UTF-8
        </span>
        <span>
          {task ? labels[task.status] || task.status : '就绪'}
          <span className="status-divider">|</span>
          {settings?.model || '模型未配置'}
        </span>
      </footer>
      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          close={() => setSettingsOpen(false)}
          saved={setSettings}
        />
      )}
    </div>
  );
}
