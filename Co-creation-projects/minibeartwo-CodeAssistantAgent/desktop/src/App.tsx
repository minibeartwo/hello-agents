import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientHome, ClientTitlebar } from './ClientHome';
import type { HomeAction } from './ClientHome';
import { FeatureDialog } from './FeatureDialog';
import { SettingsDialog } from './SettingsDialog';
import type { ModelSettings, Session, Task, TaskEvent, Workspace } from './types';

const terminal = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'budget_exhausted',
  'rejected',
]);
const presets: Record<HomeAction, string> = {
  comment:
    '【代码注释】请为当前项目代码添加清晰、准确的中文注释，说明文件职责、函数用途、参数与返回值，并解释必要的专业术语。保留现有代码逻辑与项目结构，避免重复或无意义的注释。先阅读项目，提出修改供我审阅。',
  analysis:
    '【项目解析】请解析当前项目，梳理项目用途、目录结构、技术栈、主要模块与调用关系、安装配置和运行方式，生成清晰的中文项目说明文档。以实际代码为依据；需要补充文档文件时，先提出修改供我审阅。',
};
const call = <T,>(method: string, path: string, body?: unknown) =>
  window.codeAssistant.request<T>(method, path, body);
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );
const modeFor = (task: Task): HomeAction =>
  /【项目解析】|项目说明文档|解析当前项目/.test(task.prompt) ? 'analysis' : 'comment';

async function projectTasks(workspaceId: string) {
  const sessions = await call<Session[]>('GET', `/api/sessions?workspace_id=${workspaceId}`);
  const batches = await Promise.all(
    sessions.map((session) => call<Task[]>('GET', `/api/sessions/${session.id}/tasks`)),
  );
  return batches.flatMap((batch) => [...batch].reverse());
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [importing, setImporting] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [featureOpen, setFeatureOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [action, setAction] = useState<HomeAction>('comment');
  const [drafts, setDrafts] = useState({ ...presets });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [activity, setActivity] = useState<TaskEvent[]>([]);
  const [logs, setLogs] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [testEnabled, setTestEnabled] = useState(false);
  const [testCommand, setTestCommand] = useState('python -m pytest -q');
  const taskRef = useRef<Task | null>(null);
  const workspaceRef = useRef<string | null>(null);
  workspaceRef.current = workspace?.id || null;
  const busy = !!task && !terminal.has(task.status);
  const report = useCallback((error: unknown) => setError(message(error)), []);
  const selectTask = useCallback((next: Task | null) => {
    taskRef.current = next;
    setTask(next);
  }, []);

  useEffect(() => {
    if (!window.codeAssistant) {
      setError('请通过项目桌面启动命令打开代码助手。');
      setBooting(false);
      return;
    }
    window.codeAssistant
      .bootstrap()
      .then((value) => {
        setSettings(value.settings);
        setWorkspace(value.workspaces[0] || null);
      })
      .catch(report)
      .finally(() => setBooting(false));
  }, [report]);

  useEffect(() => {
    selectTask(null);
    setTasks([]);
    setActivity([]);
    setLogs('');
    if (!workspace) return;
    let active = true;
    projectTasks(workspace.id)
      .then(async (history) => {
        if (!active) return;
        const current = taskRef.current;
        setTasks(
          current && !history.some((item) => item.id === current.id)
            ? [current, ...history]
            : history,
        );
        const pending = history.find((item) => !terminal.has(item.status));
        if (pending) {
          const recovered = await call<Task>('GET', `/api/tasks/${pending.id}`);
          if (!active || taskRef.current) return;
          selectTask(recovered);
          setAction(modeFor(recovered));
          setSelectedFile(recovered.selected_file || null);
          setTestEnabled(!!recovered.test_argv?.length);
          if (recovered.test_argv?.length) setTestCommand(recovered.test_argv.join(' '));
          setVisited(true);
        }
      })
      .catch((error) => {
        if (active) report(error);
      });
    return () => {
      active = false;
    };
  }, [workspace?.id, report, selectTask]);

  const refreshTask = useCallback(
    async (id: string) => {
      const updated = await call<Task>('GET', `/api/tasks/${id}`);
      if (taskRef.current?.id === id) selectTask(updated);
      setTasks((previous) => previous.map((item) => (item.id === id ? updated : item)));
    },
    [selectTask],
  );

  useEffect(() => {
    const id = task?.id;
    if (!id) {
      setActivity([]);
      setLogs('');
      return;
    }
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
      if (event.kind === 'agent.step' && taskRef.current?.id === id)
        selectTask({ ...taskRef.current, steps: event.data.step || 0 });
      if (
        event.kind.startsWith('task.') ||
        event.kind.startsWith('patch.') ||
        event.kind === 'command.completed'
      )
        void refreshTask(id).catch(report);
      if (event.kind === 'connection.error')
        report(event.data.message || '任务连接中断，请重新打开任务重试。');
    });
    void window.codeAssistant.watchTask(id).catch(report);
    return () => {
      remove();
      void window.codeAssistant.unwatchTask(id).catch(() => {});
    };
  }, [task?.id, refreshTask, report, selectTask]);

  function setProject(next: Workspace, file: string | null) {
    selectTask(null);
    if (next.id !== workspace?.id) {
      setDrafts({ ...presets });
      setVisited(false);
    }
    setWorkspace(next);
    setSelectedFile(file);
    setError('');
  }
  async function chooseProject() {
    if (busy || sending) {
      report('请先结束当前任务，再切换项目。');
      return null;
    }
    setImporting(true);
    try {
      const selected = await window.codeAssistant.openWorkspace();
      if (selected) setProject(selected, null);
      return selected;
    } catch (error) {
      report(error);
      return null;
    } finally {
      setImporting(false);
    }
  }
  async function dropProject(file: File) {
    if (busy || sending) {
      report('请先结束当前任务，再切换项目。');
      return;
    }
    setImporting(true);
    try {
      const imported = await window.codeAssistant.openDroppedProject(file);
      setProject(imported.workspace, imported.selectedFile);
    } catch (error) {
      report(error);
    } finally {
      setImporting(false);
    }
  }
  async function openFeature(next: HomeAction) {
    if (!workspace && !(await chooseProject())) return;
    if (!busy && !sending && next !== action) {
      selectTask(null);
      setAction(next);
    }
    setVisited(true);
    setFeatureOpen(true);
    setError('');
  }
  async function start() {
    if (!workspace || sending || busy) return;
    if (!settings?.model) {
      setSettingsOpen(true);
      return;
    }
    if (!drafts[action].trim()) {
      report('请填写任务需求。');
      return;
    }
    setSending(true);
    setError('');
    try {
      const created = await call<Task>('POST', '/api/tasks', {
        workspace_id: workspace.id,
        session_id: null,
        prompt: drafts[action]
          .trim()
          .startsWith(action === 'comment' ? '【代码注释】' : '【项目解析】')
          ? drafts[action].trim()
          : `${action === 'comment' ? '【代码注释】' : '【项目解析】'}\n${drafts[action].trim()}`,
        selected_file: selectedFile,
        test_argv: testEnabled ? testCommand.trim().split(/\s+/).filter(Boolean) : [],
      });
      selectTask(created);
      setTasks((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
    } catch (error) {
      report(error);
    } finally {
      setSending(false);
    }
  }
  async function loadTask(id: string) {
    if (!id || (busy && task?.id !== id) || sending) return;
    setOperationPending(true);
    setError('');
    const projectId = workspace?.id;
    try {
      const loaded = await call<Task>('GET', `/api/tasks/${id}`);
      if (projectId !== workspaceRef.current) return;
      selectTask(loaded);
      const mode = modeFor(loaded);
      setAction(mode);
      setDrafts((previous) => ({ ...previous, [mode]: loaded.prompt }));
      setSelectedFile(loaded.selected_file || null);
      setTestEnabled(!!loaded.test_argv?.length);
      if (loaded.test_argv?.length) setTestCommand(loaded.test_argv.join(' '));
    } catch (error) {
      report(error);
    } finally {
      setOperationPending(false);
    }
  }
  async function taskOperation(route: string, body: unknown = {}) {
    const id = task?.id;
    if (!id || operationPending) return;
    setOperationPending(true);
    setError('');
    try {
      await call('POST', route, body);
      await refreshTask(id);
    } catch (error) {
      report(error);
    } finally {
      setOperationPending(false);
    }
  }
  function newTask() {
    if (busy || sending) return;
    selectTask(null);
    setDrafts((previous) => ({ ...previous, [action]: presets[action] }));
    setError('');
  }

  return (
    <div className="app-shell client-home">
      <ClientTitlebar
        canResume={visited}
        onResume={() => setFeatureOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        settingsReady={!!settings}
        report={report}
      />
      {error && !featureOpen && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button aria-label="关闭错误提示" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      <ClientHome
        workspace={workspace}
        booting={booting}
        importing={importing}
        onChoose={() => void chooseProject()}
        onDrop={(file) => void dropProject(file)}
        onAction={(next) => void openFeature(next)}
      />
      {featureOpen && workspace && (
        <FeatureDialog
          action={action}
          workspace={workspace}
          selectedFile={selectedFile}
          settings={settings}
          task={task}
          tasks={tasks}
          prompt={drafts[action]}
          onPromptChange={(value) => setDrafts((previous) => ({ ...previous, [action]: value }))}
          testEnabled={testEnabled}
          testCommand={testCommand}
          onTestsChange={setTestEnabled}
          onTestCommandChange={setTestCommand}
          busy={busy}
          sending={sending}
          operationPending={operationPending}
          activity={activity}
          logs={logs}
          error={error}
          onClose={() => setFeatureOpen(false)}
          onSettings={() => setSettingsOpen(true)}
          onStart={() => void start()}
          onLoadTask={(id) => void loadTask(id)}
          onNewTask={newTask}
          onReview={(patchId, accept) =>
            void taskOperation(`/api/patches/${patchId}/review`, { accept })
          }
          onUndo={(patchId) => void taskOperation(`/api/patches/${patchId}/undo`)}
          onCancel={() => {
            if (task) void taskOperation(`/api/tasks/${task.id}/cancel`);
          }}
        />
      )}
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
