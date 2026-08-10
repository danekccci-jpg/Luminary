/**
 * SettingsModal.tsx — настройки приложения («console sheet»).
 *
 * Единая система с панелью раздач: графит + hairline-границы, спокойные
 * акценты (лёд/изумруд/янтарь), статусы точками, endpoints моноширинным.
 * Группы разделены линиями, а не карточками; длинные пояснения срезаны
 * до одной строки. Избыточные источники (Jackett/Prowlarr) и дублирующая
 * форма кредов RuTracker убраны — вход идёт через окно приложения / веб-UI.
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, Power, Search, MonitorPlay, KeyRound, ExternalLink, RefreshCw, ScrollText, AlertTriangle } from 'lucide-react';
import logoUrl from '../assets/logo.png';
import { TorrServerStatusInfo, UserSettings } from '../types';
import { torrServerService } from '../services/torrserver';
import { JacredServerStatus, startJacredServer, stopJacredServer, openJacredUi, getJacredAuthStatus, JacredAuthStatus } from '../services/jacredServer';
import { getRutrackerStatus, openRutrackerLogin, hideRutrackerLogin, onRutrackerStatusChanged, RutrackerStatus } from '../services/rutrackerService';
import { useFocusTrap } from '../utils/focus';
import { registerBackHandler, getTvModeSetting } from '../utils/tv';

interface SettingsModalProps {
  settings: UserSettings;
  onSaveSettings: (newSettings: UserSettings) => void;
  onClose: () => void;
  torrServerStatus: TorrServerStatusInfo;
  onRefreshStatus: () => void;
  /** Встроенный локальный JacRed (Zero-Config): бинарник + spawn в Main Process. */
  jacredServerStatus: JacredServerStatus;
  onRefreshJacredStatus: () => void;
}

/** Компактный тумблер (трек + кноб) в стиле системы. */
const Toggle: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
  <button onClick={onToggle} aria-pressed={on} aria-label={label} className={`settings-toggle${on ? ' on' : ''}`}>
    <span className="knob" />
  </button>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onSaveSettings,
  onClose,
  torrServerStatus,
  onRefreshStatus,
  jacredServerStatus,
  onRefreshJacredStatus,
}) => {
  const [tmdbKey,        setTmdbKey]        = useState(settings.tmdbApiKey);
  const [ramCache,       setRamCache]       = useState<256 | 512 | 1024 | 2048>(settings.ramCacheMB || 512);
  const [jacredUrl,      setJacredUrl]      = useState(settings.jacredUrl || '');
  const [kodikToken,     setKodikToken]     = useState(settings.kodikToken || '');
  const [transcodeAudio, setTranscodeAudio] = useState(settings.transcodeAudioToAac ?? true);
  const [platformInfo,   setPlatformInfo]   = useState({ platform: 'desktop', arch: 'x64' });
  const [isToggling,     setIsToggling]     = useState(false);
  const [isTogglingJacred, setIsTogglingJacred] = useState(false);
  /** Авторизация приватных трекеров (RuTracker / NNM-Club) в локальном JacRed. */
  const [jacredAuth, setJacredAuth] = useState<JacredAuthStatus | null>(null);
  /** Браузерный сеанс RuTracker (окно входа в приложении). */
  const [rtStatus, setRtStatus] = useState<RutrackerStatus>({ loggedIn: false, loginWindowOpen: false });
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  /** TV-режим (пульт) — тумблер для теста на десктопе; на Android TV включается сам. */
  const [tvMode, setTvModeLocal] = useState(getTvModeSetting());

  // ── TV/клавиатура: focus trap + Back (пульт/Escape) закрывает ──
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, modalRef);
  useEffect(() => registerBackHandler(() => { onClose(); return true; }), [onClose]);

  // Загрузка логов TorrServer (последние 100 строк из torrserver.log)
  const refreshLogs = async () => {
    const lines = await torrServerService.getLogs(100);
    setLogs(lines);
  };

  useEffect(() => {
    if (showLogs) refreshLogs();
  }, [showLogs]);

  // При открытии Настроек — прямой запрос актуального статуса сервисов
  useEffect(() => {
    onRefreshStatus();
    onRefreshJacredStatus();
    getJacredAuthStatus().then(setJacredAuth).catch(() => setJacredAuth(null));
    getRutrackerStatus().then(setRtStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push-подписка: bb_session появился/пропал (вход/выход в окне RuTracker)
  useEffect(() => {
    const off = onRutrackerStatusChanged((st) => {
      setRtStatus((prev) => ({ ...prev, loggedIn: !!st.loggedIn }));
    });
    return off;
  }, []);

  useEffect(() => {
    if (window.electronAPI?.getPlatformInfo) {
      window.electronAPI.getPlatformInfo().then(setPlatformInfo);
    }
  }, []);

  const handleToggleServer = async () => {
    setIsToggling(true);
    if (torrServerStatus.running) {
      await torrServerService.stopServer();
    } else {
      await torrServerService.startServer();
    }
    onRefreshStatus();
    setIsToggling(false);
  };

  const handleToggleJacred = async () => {
    setIsTogglingJacred(true);
    if (jacredServerStatus.running) {
      await stopJacredServer();
    } else {
      await startJacredServer();
    }
    onRefreshJacredStatus();
    setIsTogglingJacred(false);
  };

  const handleOpenJacredUi = async () => {
    await openJacredUi();
  };

  /** Открыть видимое окно входа RuTracker (проходит Cloudflare) — надёжный путь. */
  const handleRtOpenLogin = async () => {
    setRtStatus(await openRutrackerLogin());
  };

  const handleRtHideLogin = async () => {
    await hideRutrackerLogin();
    setRtStatus((prev) => ({ ...prev, loginWindowOpen: false }));
  };

  const handleSave = () => {
    onSaveSettings({
      ...settings, // jackettUrl/jackettApiKey не трогаем — поле убрано, значения сохраняются
      tmdbApiKey: tmdbKey,
      ramCacheMB: ramCache,
      jacredUrl,
      kodikToken,
      transcodeAudioToAac: transcodeAudio,
      tvMode,
    });
    torrServerService.configureServer(ramCache);
    onClose();
  };

  // ── Производные состояния для отрисовки ──
  const serverCls = torrServerStatus.running ? 'on' : torrServerStatus.starting ? 'starting' : 'off';
  const serverText = torrServerStatus.running ? 'Online' : torrServerStatus.starting ? 'Запуск…' : 'Offline';
  const serverBtnText = isToggling
    ? 'Обработка…'
    : torrServerStatus.running
    ? 'Остановить процесс'
    : torrServerStatus.starting
    ? 'Запуск сервиса…'
    : 'Запустить TorrServer';
  const serverDisabled = isToggling || !!torrServerStatus.starting;

  const jacredCls = jacredServerStatus.running ? 'on' : jacredServerStatus.starting ? 'starting' : 'off';
  const jacredText = jacredServerStatus.running ? 'Online' : jacredServerStatus.starting ? 'Запуск…' : 'Offline';
  const jacredBtnText = isTogglingJacred
    ? 'Обработка…'
    : jacredServerStatus.running
    ? 'Остановить JacRed'
    : jacredServerStatus.starting
    ? 'Запуск сервиса…'
    : 'Запустить JacRed';
  const jacredDisabled = isTogglingJacred || !!jacredServerStatus.starting;

  return (
    <div ref={modalRef} className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-sheet" role="dialog" aria-modal="true" aria-label="Настройки">
        {/* ── Header ── */}
        <div className="settings-header">
          <img src={logoUrl} alt="" draggable={false} className="settings-logo" />
          <div>
            <div className="settings-brand">Настройки</div>
            <div className="settings-brand-sub">Luminary · Torrent Cinema</div>
          </div>
          <button className="settings-close" onClick={onClose} aria-label="Закрыть настройки">
            <X size={15} />
          </button>
        </div>

        {/* ── Сервер ── */}
        <section className="settings-group">
          <div className="settings-group-head"><Power size={13} /> Сервер</div>

          <div className="settings-row">
            <div>
              <div className="settings-label">TorrServer MatriX</div>
              <div className="settings-mono">127.0.0.1:{settings.torrServerPort} · {platformInfo.platform}/{platformInfo.arch}</div>
            </div>
            <span className={`settings-status ${serverCls}`}>
              <span className={`status-dot ${serverCls}`} />
              {serverText}
            </span>
          </div>

          <button
            className={`settings-btn ${torrServerStatus.running ? 'danger' : 'primary'}`}
            onClick={handleToggleServer}
            disabled={serverDisabled}
            style={{ width: '100%' }}
          >
            <Power size={13} />
            {serverBtnText}
          </button>

          {!torrServerStatus.running && !torrServerStatus.starting && torrServerStatus.error && (
            <div className="settings-alert">
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{torrServerStatus.error}</div>
                {torrServerStatus.errorLog && <pre>{torrServerStatus.errorLog}</pre>}
                <button
                  onClick={handleToggleServer}
                  className="settings-btn"
                  style={{ marginTop: 8, height: 28, fontSize: '0.7rem' }}
                >
                  <RefreshCw size={12} />
                  Перезапустить
                </button>
              </div>
            </div>
          )}

          <button
            className="settings-btn"
            onClick={() => setShowLogs(!showLogs)}
            style={{ width: '100%', marginTop: 10 }}
            aria-expanded={showLogs}
          >
            <ScrollText size={13} />
            {showLogs ? 'Скрыть диагностику' : 'Диагностика'}
          </button>

          {showLogs && (
            <div className="settings-log">
              <div className="settings-log-head">
                <span>torrserver.log · {logs.length} строк</span>
                <button className="settings-btn" onClick={refreshLogs} style={{ height: 24, padding: '0 8px', fontSize: '0.64rem' }}>
                  <RefreshCw size={10} />
                  Обновить
                </button>
              </div>
              <pre className="settings-log-body">
                {logs.length > 0 ? logs.join('\n') : 'Лог пуст — сервис ещё не запускался'}
              </pre>
            </div>
          )}
        </section>

        {/* ── Поиск раздач ── */}
        <section className="settings-group">
          <div className="settings-group-head"><Search size={13} /> Поиск раздач</div>

          <div className="settings-row">
            <div>
              <div className="settings-label">JacRed (встроенный)</div>
              <div className="settings-mono">127.0.0.1:9117 · RuTracker · NNM · Rutor</div>
            </div>
            <span className={`settings-status ${jacredCls}`}>
              <span className={`status-dot ${jacredCls}`} />
              {jacredText}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`settings-btn ${jacredServerStatus.running ? 'danger' : 'primary'}`}
              onClick={handleToggleJacred}
              disabled={jacredDisabled}
              style={{ flex: 1 }}
            >
              <Power size={13} />
              {jacredBtnText}
            </button>
            <button
              className="settings-btn"
              onClick={handleOpenJacredUi}
              disabled={!jacredServerStatus.running}
              style={{ flex: 1 }}
            >
              <ExternalLink size={13} />
              Веб-интерфейс
            </button>
          </div>

          {!jacredServerStatus.running && !jacredServerStatus.starting && jacredServerStatus.error && (
            <p className="settings-desc" style={{ color: '#E8A0AC', marginTop: 8 }}>
              {jacredServerStatus.error}
            </p>
          )}

          {/* Приватные трекеры: статус авторизации */}
          {jacredServerStatus.running && jacredAuth && (
            <div style={{ marginTop: 12 }}>
              {(['rutracker', 'nnmClub'] as const).map((key) => {
                const label = key === 'rutracker' ? 'RuTracker' : 'NNM-Club';
                const authed = !!jacredAuth[key];
                return (
                  <div key={key} className="settings-row" style={{ marginBottom: 8 }}>
                    <div className="settings-label" style={{ fontSize: '0.76rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`status-dot ${authed ? 'on' : 'off'}`} />
                      {label}
                    </div>
                    {authed ? (
                      <span className="settings-status on"><span className="status-dot on" /> Авторизован</span>
                    ) : (
                      <button className="settings-btn" onClick={handleOpenJacredUi} style={{ height: 28, fontSize: '0.7rem' }}>
                        Настроить
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* RuTracker: вход в окне приложения */}
          {jacredServerStatus.running && (
            <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
              <div className="settings-row" style={{ marginBottom: 10 }}>
                <div>
                  <div className="settings-label" style={{ fontSize: '0.78rem' }}>RuTracker — вход в приложении</div>
                  <div className="settings-desc">rutracker.org блокирует автологин (Cloudflare) — вход как на сайте.</div>
                </div>
                <span className={`settings-status ${rtStatus.loggedIn ? 'on' : 'off'}`}>
                  <span className={`status-dot ${rtStatus.loggedIn ? 'on' : 'off'}`} />
                  {rtStatus.loggedIn ? 'Сессия активна' : 'Не вошли'}
                </span>
              </div>
              <button
                className="settings-btn primary"
                onClick={rtStatus.loginWindowOpen ? handleRtHideLogin : handleRtOpenLogin}
                style={{ width: '100%' }}
              >
                {rtStatus.loginWindowOpen ? <><X size={13} /> Скрыть окно входа</> : <><ExternalLink size={13} /> Войти в RuTracker</>}
              </button>
            </div>
          )}

          {/* Свой JacRed-инстанс */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
            <div className="settings-label" style={{ fontSize: '0.78rem', marginBottom: 6 }}>Свой JacRed-инстанс</div>
            <input
              type="text"
              value={jacredUrl}
              onChange={(e) => setJacredUrl(e.target.value)}
              placeholder="https://ваш-инстанс/jacred"
              className="settings-input"
            />
            <div className="settings-desc">Пусто = встроенный JacRed + публичные зеркала.</div>
          </div>
        </section>

        {/* ── Воспроизведение ── */}
        <section className="settings-group">
          <div className="settings-group-head"><MonitorPlay size={13} /> Воспроизведение</div>

          <div className="settings-row" style={{ marginBottom: 10 }}>
            <div>
              <div className="settings-label">Буфер RAM-кэша</div>
              <div className="settings-desc">512 MB — 1080p · 1–2 GB — 4K REMUX.</div>
            </div>
          </div>
          <div className="settings-segmented" style={{ marginBottom: 16 }}>
            {([256, 512, 1024, 2048] as const).map((mb) => (
              <button
                key={mb}
                onClick={() => setRamCache(mb)}
                className={`settings-seg${ramCache === mb ? ' active' : ''}`}
                aria-pressed={ramCache === mb}
              >
                {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
              </button>
            ))}
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-label">AC3/DTS → Stereo AAC</div>
              <div className="settings-desc">Микшировать многоканальный звук 5.1/7.1 в стерео.</div>
            </div>
            <Toggle on={transcodeAudio} onToggle={() => setTranscodeAudio(!transcodeAudio)} label="Аудио AC3/DTS → Stereo AAC" />
          </div>

          <div className="settings-row" style={{ marginTop: 14 }}>
            <div>
              <div className="settings-label">TV-пульт (D-pad)</div>
              <div className="settings-desc">Навигация пультом. На Android TV включается сам.</div>
            </div>
            <Toggle on={tvMode} onToggle={() => setTvModeLocal(!tvMode)} label="TV-пульт (D-pad)" />
          </div>
        </section>

        {/* ── Доступы ── */}
        <section className="settings-group">
          <div className="settings-group-head"><KeyRound size={13} /> Доступы</div>

          <div style={{ marginBottom: 14 }}>
            <div className="settings-label" style={{ fontSize: '0.78rem', marginBottom: 6 }}>Kodik API-токен</div>
            <input
              type="password"
              value={kodikToken}
              onChange={(e) => setKodikToken(e.target.value)}
              placeholder="Бесплатно на kodikapi.com"
              className="settings-input"
            />
            <div className="settings-desc">Второй надёжный источник онлайн-потоков помимо VK. Пусто = пропускается.</div>
          </div>

          <div>
            <div className="settings-label" style={{ fontSize: '0.78rem', marginBottom: 6 }}>TMDB API-ключ</div>
            <input
              type="text"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              placeholder="Встроенный ключ TMDB…"
              className="settings-input"
            />
            <div className="settings-desc">Оставьте пустым — используется встроенный ключ.</div>
          </div>
        </section>

        {/* ── Footer ── */}
        <div className="settings-foot">
          <button className="settings-btn" onClick={onClose}>
            Отмена
          </button>
          <button className="settings-btn primary" onClick={handleSave}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
};
