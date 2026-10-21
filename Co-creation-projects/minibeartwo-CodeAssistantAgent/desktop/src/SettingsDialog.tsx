import { useState } from 'react';
import { useDialogFocus } from './FeatureDialog';
import type { ModelSettings } from './types';

export function SettingsDialog({
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
  const dialog = useDialogFocus<HTMLFormElement>(() => {
    if (!busy) close();
  });
  const update = (key: string, value: string | number) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <div className="modal-shade settings-shade">
      <form
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="模型设置"
        tabIndex={-1}
        className="settings-dialog"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            saved(await window.codeAssistant.request<ModelSettings>('PUT', '/api/settings', form));
            close();
          } catch (error) {
            setError(
              String(error instanceof Error ? error.message : error).replace(
                /^Error invoking remote method '[^']+': Error: /,
                '',
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="feature-eyebrow">MODEL CONNECTION</span>
            <h2>连接你的模型</h2>
          </div>
          <button
            type="button"
            className="feature-close"
            onClick={close}
            disabled={busy}
            aria-label="关闭模型设置"
          >
            ×
          </button>
        </div>
        <p className="muted">支持兼容 API 的云端服务与本地模型，配置保存在当前电脑。</p>
        <label>
          API 地址
          <input
            required
            name="base_url"
            value={form.base_url}
            disabled={busy}
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
            disabled={busy}
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
            disabled={busy}
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
              required
              value={form.max_steps}
              disabled={busy}
              onChange={(event) => update('max_steps', Number(event.target.value))}
            />
          </label>
          <label>
            执行时间上限（秒）
            <input
              type="number"
              min="30"
              max="1800"
              required
              value={form.task_timeout}
              disabled={busy}
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
          <button type="button" className="secondary" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存连接'}
          </button>
        </div>
      </form>
    </div>
  );
}
