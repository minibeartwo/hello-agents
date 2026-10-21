import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { Workspace } from './types';

export type HomeAction = 'comment' | 'analysis';

export function Butterfly({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient
          id="butterfly-wing"
          x1="10"
          y1="3"
          x2="49"
          y2="57"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f4ffff" />
          <stop offset=".4" stopColor="#55d7ff" />
          <stop offset=".7" stopColor="#3b80ff" />
          <stop offset="1" stopColor="#d2faff" />
        </linearGradient>
      </defs>
      <path
        d="M30 31C21 8 2-2 7 19c3 11 13 15 23 14ZM34 31C43 8 62-2 57 19c-3 11-13 15-23 14ZM29 35C13 29 5 39 11 51c5 9 16-4 19-14ZM35 35c16-6 24 4 18 16-5 9-16-4-19-14Z"
        fill="url(#butterfly-wing)"
        stroke="#b8f5ff"
        strokeWidth="1.4"
      />
      <path
        d="M11 13 27 29 15 24m38-11L37 29l12-5M15 45l13-9m21 9-13-9"
        stroke="#e2ffff"
        strokeWidth="1.7"
      />
      <path d="m28 23 4 8 4-8m-4 8v16" stroke="#f4ffff" strokeWidth="2" strokeLinecap="round" />
      <path d="m12 55 1-4m38 4-1-4" stroke="#d4faff" strokeWidth="2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 160 150" fill="none" aria-hidden="true">
      <path
        d="M17 43V33c0-10 7-17 17-17h31c8 0 10 5 18 14h43c11 0 18 7 18 18v77c0 10-7 17-17 17H34c-10 0-17-7-17-17V43Z"
        fill="#1c65db"
        fillOpacity=".4"
        stroke="#78dcff"
        strokeWidth="8"
      />
      <path
        d="M17 43V33c0-10 7-17 17-17h31c8 0 10 5 18 14h43c11 0 18 7 18 18v77c0 10-7 17-17 17H34c-10 0-17-7-17-17V43Z"
        stroke="white"
        strokeWidth="3.5"
      />
      <path
        d="M73 62h15v29h16l-24 24-24-24h17V62Z"
        fill="#a3edff"
        stroke="white"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocumentIcon({ code = false }: { code?: boolean }) {
  return (
    <svg viewBox="0 0 100 110" fill="none" aria-hidden="true">
      <path
        d="M66 10H23c-5 0-8 3-8 8v76c0 5 3 8 8 8h59c5 0 8-3 8-8V35L66 10Zm0 0v25h24"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      {code ? (
        <>
          <path
            d="m38 52-12 11 12 11m27-22 12 11-12 11M57 48 46 79"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="m58 93 28-30 10 10-28 30-13 4 3-14Zm23-25 10 10"
            fill="#126bdf"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d="M31 51h40M31 66h40M31 81h28"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function ClientTitlebar({
  canResume,
  onResume,
  onSettings,
  settingsReady,
  report,
}: {
  canResume: boolean;
  onResume: () => void;
  onSettings: () => void;
  settingsReady: boolean;
  report: (error: unknown) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    const sync = () => {
      if (!window.codeAssistant) return;
      void window.codeAssistant
        .windowState()
        .then((state) => {
          if (active) setMaximized(state.maximized);
        })
        .catch(report);
    };
    sync();
    window.addEventListener('resize', sync);
    return () => {
      active = false;
      window.removeEventListener('resize', sync);
    };
  }, [report]);
  async function control(action: 'minimize' | 'maximize' | 'close') {
    try {
      const state = await window.codeAssistant.windowControl(action);
      setMaximized(state.maximized);
    } catch (error) {
      report(error);
    }
  }
  return (
    <header className="client-titlebar">
      <div className="client-brand">
        <Butterfly className="client-logo" />
        <strong>代码助手</strong>
        <span>CodeAssistantAgent</span>
      </div>
      <div className="client-toolbar">
        {canResume && (
          <button className="task-resume" onClick={onResume}>
            继续任务
          </button>
        )}
        <button
          className="client-settings"
          aria-label="模型设置"
          title="模型设置"
          disabled={!settingsReady}
          onClick={onSettings}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m10 3-.6 2.1-2 .9-2-.6L3.5 8l1.5 1.6v2.8L3.5 14l1.9 2.6 2-.6 2 .9L10 19h3l.6-2.1 2-.9 2 .6 1.9-2.6-1.5-1.6V9.6L19.5 8l-1.9-2.6-2 .6-2-.9L13 3h-3Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <circle cx="11.5" cy="11" r="3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <div className="window-controls">
        <button aria-label="最小化" onClick={() => void control('minimize')}>
          <svg viewBox="0 0 20 20">
            <path d="M3 10h14" />
          </svg>
        </button>
        <button aria-label="最大化或还原" onClick={() => void control('maximize')}>
          <svg viewBox="0 0 20 20">
            {maximized ? <path d="M6 6V3h11v11h-3M3 6h11v11H3Z" /> : <path d="M3 3h14v14H3Z" />}
          </svg>
        </button>
        <button
          className="window-close"
          aria-label="关闭窗口"
          onClick={() => void control('close')}
        >
          <svg viewBox="0 0 20 20">
            <path d="m4 4 12 12M16 4 4 16" />
          </svg>
        </button>
      </div>
    </header>
  );
}

export function ClientHome({
  workspace,
  booting,
  importing,
  onChoose,
  onDrop,
  onAction,
}: {
  workspace: Workspace | null;
  booting: boolean;
  importing: boolean;
  onChoose: () => void;
  onDrop: (file: File) => void;
  onAction: (action: HomeAction) => void;
}) {
  const [dragging, setDragging] = useState(false);
  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (booting || importing) return;
    const file = event.dataTransfer.files[0];
    if (file) onDrop(file);
  }
  return (
    <main className="home-content" aria-label="代码助手首页">
      <div className="home-grid">
        <button
          className={`project-drop ${dragging ? 'is-dragging' : ''}`}
          aria-label="导入项目"
          disabled={booting || importing}
          onClick={onChoose}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={drop}
        >
          <span className="drop-interior">
            <span className="folder-illustration">
              <i className="magic-star" />
              <FolderIcon />
              <i className="magic-star" />
            </span>
            <strong>
              {booting
                ? '正在连接本地服务'
                : importing
                  ? '正在导入项目…'
                  : dragging
                    ? '松开以导入项目'
                    : '将项目拖入这里'}
            </strong>
            <span className="drop-description">拖入整个项目文件夹或代码文件</span>
            {workspace && (
              <span className="selected-project" title={workspace.root}>
                当前项目：{workspace.name}
              </span>
            )}
          </span>
        </button>
        <div className="home-actions">
          <button
            className="home-action home-action-comment"
            onClick={() => onAction('comment')}
            disabled={booting || importing}
          >
            <span className="action-icon">
              <DocumentIcon code />
            </span>
            <span className="action-copy">
              <strong>代码注释</strong>
              <span>
                为项目代码
                <br />
                生成中文注释
              </span>
            </span>
            <Butterfly className="card-butterfly" />
            <span className="card-orbit" aria-hidden="true" />
          </button>
          <button
            className="home-action home-action-analysis"
            onClick={() => onAction('analysis')}
            disabled={booting || importing}
          >
            <span className="action-icon">
              <DocumentIcon />
            </span>
            <span className="action-copy">
              <strong>项目解析</strong>
              <span>生成项目说明文档</span>
            </span>
            <span className="gold-star" aria-hidden="true">
              ✧
            </span>
            <span className="card-orbit" aria-hidden="true" />
          </button>
        </div>
      </div>
    </main>
  );
}
