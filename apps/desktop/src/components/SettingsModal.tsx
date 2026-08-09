import React, { useEffect, useState } from 'react';
import { X, Key, Power, Cpu, Database, RefreshCw, ScrollText, AlertTriangle, ExternalLink } from 'lucide-react';
import logoUrl from '../assets/logo.png';
import { TorrServerStatusInfo, UserSettings } from '../types';
import { torrServerService } from '../services/torrserver';
import { JacredServerStatus, startJacredServer, stopJacredServer, openJacredUi, getJacredAuthStatus, JacredAuthStatus, jacredLoginTracker } from '../services/jacredServer';
import { getRutrackerStatus, openRutrackerLogin, hideRutrackerLogin, onRutrackerStatusChanged, RutrackerStatus } from '../services/rutrackerService';

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

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onSaveSettings,
  onClose,
  torrServerStatus,
  onRefreshStatus,
  jacredServerStatus,
  onRefreshJacredStatus,
}) => {
  const [tmdbKey,       setTmdbKey]       = useState(settings.tmdbApiKey);
  const [ramCache,      setRamCache]      = useState<256 | 512 | 1024 | 2048>(settings.ramCacheMB || 512);
  const [jackettUrl,    setJackettUrl]    = useState(settings.jackettUrl || '');
  const [jackettApiKey, setJackettApiKey] = useState(settings.jackettApiKey || '');
  const [jacredUrl,     setJacredUrl]     = useState(settings.jacredUrl || '');
  const [transcodeAudio, setTranscodeAudio] = useState(settings.transcodeAudioToAac ?? true);
  const [platformInfo,  setPlatformInfo]  = useState({ platform: 'desktop', arch: 'x64' });
  const [isToggling,    setIsToggling]    = useState(false);
  const [isTogglingJacred, setIsTogglingJacred] = useState(false);
  /** Авторизация приватных трекеров (RuTracker / NNM-Club) в локальном JacRed. */
  const [jacredAuth, setJacredAuth] = useState<JacredAuthStatus | null>(null);
  /** Браузерный сеанс RuTracker (окно входа в приложении). */
  const [rtStatus, setRtStatus] = useState<RutrackerStatus>({ loggedIn: false, loginWindowOpen: false });
  const [rtForm, setRtForm] = useState({ username: '', password: '' });
  const [rtBusy, setRtBusy] = useState(false);
  const [rtMsg, setRtMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showLogs,      setShowLogs]      = useState(false);
  const [logs,          setLogs]          = useState<string[]>([]);

  // Загрузка логов TorrServer (последние 100 строк из torrserver.log)
  const refreshLogs = async () => {
    const lines = await torrServerService.getLogs(100);
    setLogs(lines);
  };

  useEffect(() => {
    if (showLogs) refreshLogs();
  }, [showLogs]);

  // При открытии Настроек — прямой запрос актуального статуса TorrServer
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

  /** Сохранить креды RuTracker в конфиг JacRed + разгон парсера (для NNM-Club работает сразу). */
  const handleRtSaveCreds = async () => {
    if (!rtForm.username.trim() || !rtForm.password.trim()) return;
    setRtBusy(true);
    setRtMsg(null);
    const res = await jacredLoginTracker('rutracker', {
      username: rtForm.username.trim(),
      password: rtForm.password,
    });
    setRtBusy(false);
    if (res.success) {
      setRtMsg({
        ok: true,
        text: 'Креды сохранены в JacRed, парсер разогнан. Для NNM-Club раздачи появятся сразу; для RuTracker войдите в окно ниже — сайт блокирует парсер.',
      });
      getJacredAuthStatus().then(setJacredAuth).catch(() => {});
    } else {
      setRtMsg({ ok: false, text: res.error || 'Ошибка сохранения кредов' });
    }
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
      ...settings,
      tmdbApiKey: tmdbKey,
      ramCacheMB: ramCache,
      jackettUrl,
      jackettApiKey,
      jacredUrl,
      transcodeAudioToAac: transcodeAudio,
    });
    torrServerService.configureServer(ramCache);
    onClose();
  };

  const sectionTitle = (label: string, color: string = 'rgba(0,242,254,0.55)') => (
    <div style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color, marginBottom: '0.7rem' }}>
      {label}
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        background: 'rgba(0,0,0,0.9)',
        animation: 'fadeIn 0.2s ease',
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '500px',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'rgba(11,12,17,0.99)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '28px',
          padding: '2rem',
          boxShadow: '0 32px 80px rgba(0,0,0,0.9)',
          animation: 'scaleIn 0.3s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Cyan top shimmer */}
        <div style={{ position: 'absolute', top: 0, left: '15%', right: '15%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(0,242,254,0.4), rgba(138,43,226,0.4), transparent)' }} />

        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '1.1rem',
            right: '1.1rem',
            width: '34px',
            height: '34px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(240,242,248,0.5)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,84,112,0.2)';
            (e.currentTarget as HTMLButtonElement).style.color = '#FF5470';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
            (e.currentTarget as HTMLButtonElement).style.color = 'rgba(240,242,248,0.5)';
          }}
        >
          <X size={14} />
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.8rem' }}>
          <img
            src={logoUrl}
            alt="Luminary"
            draggable={false}
            style={{ width: '40px', height: '40px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 0 16px rgba(0,242,254,0.12)' }}
          />
          <div>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>Настройки Luminary</h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>TorrServer MatriX · TMDB · Парсер торрентов</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.4rem' }}>
          {/* TorrServer Status Card */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px', padding: '1.2rem' }}>
            {sectionTitle('TorrServer MatriX')}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Фоновый процесс</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                  http://127.0.0.1:{settings.torrServerPort} · {platformInfo.platform}/{platformInfo.arch}
                </div>
              </div>
              <div style={{
                padding: '3px 12px',
                borderRadius: '999px',
                fontSize: '0.72rem',
                fontWeight: 800,
                background: torrServerStatus.running ? 'rgba(16,245,172,0.1)' : torrServerStatus.starting ? 'rgba(255,184,0,0.1)' : 'rgba(255,84,112,0.1)',
                border: `1px solid ${torrServerStatus.running ? 'rgba(16,245,172,0.35)' : torrServerStatus.starting ? 'rgba(255,184,0,0.4)' : 'rgba(255,84,112,0.35)'}`,
                color: torrServerStatus.running ? 'var(--emerald)' : torrServerStatus.starting ? 'var(--amber)' : 'var(--coral)',
                boxShadow: torrServerStatus.running ? '0 0 10px rgba(16,245,172,0.2)' : torrServerStatus.starting ? '0 0 10px rgba(255,184,0,0.2)' : '0 0 10px rgba(255,84,112,0.2)',
              }}>
                {torrServerStatus.running ? '● Online' : torrServerStatus.starting ? '◐ Запуск сервиса...' : '○ Offline'}
              </div>
            </div>
            <button
              onClick={handleToggleServer}
              disabled={isToggling || !!torrServerStatus.starting}
              style={{
                width: '100%',
                padding: '0.65rem',
                borderRadius: '12px',
                border: `1px solid ${torrServerStatus.running ? 'rgba(255,84,112,0.3)' : torrServerStatus.starting ? 'rgba(255,184,0,0.3)' : 'rgba(16,245,172,0.3)'}`,
                background: torrServerStatus.running ? 'rgba(255,84,112,0.07)' : torrServerStatus.starting ? 'rgba(255,184,0,0.07)' : 'rgba(16,245,172,0.07)',
                color: torrServerStatus.running ? 'var(--coral)' : torrServerStatus.starting ? 'var(--amber)' : 'var(--emerald)',
                fontFamily: 'inherit',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: isToggling || torrServerStatus.starting ? 'wait' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                transition: 'all 0.2s ease',
              }}
            >
              <Power size={14} />
              <span>
                {isToggling
                  ? 'Обработка...'
                  : torrServerStatus.running
                  ? 'Остановить процесс'
                  : torrServerStatus.starting
                  ? 'Запуск сервиса...'
                  : 'Запустить TorrServer'}
              </span>
            </button>

            {/* ── Плашка ошибки старта (таймаут /echo, Gatekeeper, порт) ── */}
            {!torrServerStatus.running && !torrServerStatus.starting && torrServerStatus.error && (
              <div
                style={{
                  marginTop: '0.6rem',
                  padding: '0.9rem 1rem',
                  borderRadius: '14px',
                  background: 'rgba(255,84,112,0.08)',
                  border: '1px solid rgba(255,84,112,0.35)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                  <AlertTriangle size={15} style={{ color: '#FF5470', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'rgba(255,160,180,0.95)' }}>
                    {torrServerStatus.error}
                  </span>
                </div>
                {torrServerStatus.errorLog && (
                  <pre
                    style={{
                      margin: '0 0 0.7rem',
                      padding: '0.5rem 0.6rem',
                      background: 'rgba(0,0,0,0.4)',
                      borderRadius: '10px',
                      fontSize: '0.62rem',
                      lineHeight: 1.45,
                      color: 'rgba(255,160,180,0.7)',
                      fontFamily: 'SF Mono, Menlo, monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      maxHeight: '110px',
                      overflowY: 'auto',
                    }}
                  >
                    {torrServerStatus.errorLog}
                  </pre>
                )}
                <button
                  onClick={handleToggleServer}
                  className="btn-primary"
                  style={{ borderRadius: '10px', padding: '0.5rem 1rem', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <RefreshCw size={13} />
                  Перезапустить
                </button>
              </div>
            )}

            {/* ── Логи TorrServer (отладка) ── */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="btn-secondary"
                style={{ flex: 1, borderRadius: '12px', padding: '0.55rem', fontSize: '0.78rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
              >
                <ScrollText size={14} />
                {showLogs ? 'Скрыть логи TorrServer' : 'Посмотреть логи TorrServer'}
              </button>
            </div>
            {showLogs && (
              <div
                style={{
                  marginTop: '0.6rem',
                  background: 'rgba(0,0,0,0.5)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '14px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.8rem',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    background: 'rgba(0,242,254,0.04)',
                  }}
                >
                  <span style={{ fontSize: '0.68rem', fontWeight: 800, color: 'var(--cyan)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    torrserver.log · последние {logs.length} строк
                  </span>
                  <button
                    onClick={refreshLogs}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: 'var(--text-muted)',
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '8px',
                      padding: '3px 10px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <RefreshCw size={11} />
                    Обновить
                  </button>
                </div>
                <pre
                  style={{
                    maxHeight: '260px',
                    overflowY: 'auto',
                    padding: '0.7rem 0.8rem',
                    margin: 0,
                    fontSize: '0.66rem',
                    lineHeight: 1.5,
                    color: 'rgba(16,245,172,0.8)',
                    fontFamily: 'SF Mono, Menlo, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {logs.length > 0 ? logs.join('\n') : 'Лог пуст — сервис ещё не запускался'}
                </pre>
              </div>
            )}
          </div>

          {/* Встроенный JacRed (Zero-Config) */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px', padding: '1.2rem' }}>
            {sectionTitle('Встроенный JacRed (RuTracker · NNM · Rutor)', 'rgba(16,245,172,0.7)')}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Локальный инстанс (Zero-Config)</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                  http://127.0.0.1:9117 · бинарник скачивается при первом запуске
                </div>
              </div>
              <div style={{
                padding: '3px 12px',
                borderRadius: '999px',
                fontSize: '0.72rem',
                fontWeight: 800,
                background: jacredServerStatus.running ? 'rgba(16,245,172,0.1)' : jacredServerStatus.starting ? 'rgba(255,184,0,0.1)' : 'rgba(255,84,112,0.1)',
                border: `1px solid ${jacredServerStatus.running ? 'rgba(16,245,172,0.35)' : jacredServerStatus.starting ? 'rgba(255,184,0,0.4)' : 'rgba(255,84,112,0.35)'}`,
                color: jacredServerStatus.running ? 'var(--emerald)' : jacredServerStatus.starting ? 'var(--amber)' : 'var(--coral)',
                boxShadow: jacredServerStatus.running ? '0 0 10px rgba(16,245,172,0.2)' : 'none',
              }}>
                {jacredServerStatus.running ? '● Online' : jacredServerStatus.starting ? '◐ Запуск...' : '○ Offline'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleToggleJacred}
                disabled={isTogglingJacred || !!jacredServerStatus.starting}
                style={{
                  flex: 1,
                  padding: '0.6rem',
                  borderRadius: '12px',
                  border: `1px solid ${jacredServerStatus.running ? 'rgba(255,84,112,0.3)' : jacredServerStatus.starting ? 'rgba(255,184,0,0.3)' : 'rgba(16,245,172,0.3)'}`,
                  background: jacredServerStatus.running ? 'rgba(255,84,112,0.07)' : jacredServerStatus.starting ? 'rgba(255,184,0,0.07)' : 'rgba(16,245,172,0.07)',
                  color: jacredServerStatus.running ? 'var(--coral)' : jacredServerStatus.starting ? 'var(--amber)' : 'var(--emerald)',
                  fontFamily: 'inherit',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  cursor: isTogglingJacred || jacredServerStatus.starting ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  transition: 'all 0.2s ease',
                }}
              >
                <Power size={13} />
                <span>
                  {isTogglingJacred
                    ? 'Обработка...'
                    : jacredServerStatus.running
                    ? 'Остановить JacRed'
                    : jacredServerStatus.starting
                    ? 'Запуск сервиса...'
                    : 'Запустить JacRed'}
                </span>
              </button>
              <button
                onClick={handleOpenJacredUi}
                disabled={!jacredServerStatus.running}
                className="btn-secondary"
                style={{
                  flex: 1,
                  borderRadius: '12px',
                  padding: '0.6rem',
                  fontSize: '0.78rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  opacity: jacredServerStatus.running ? 1 : 0.45,
                  cursor: jacredServerStatus.running ? 'pointer' : 'not-allowed',
                }}
              >
                <ExternalLink size={13} />
                Настройки JacRed
              </button>
            </div>
            {/* Авторизация приватных трекеров (RuTracker / NNM-Club) */}
            {jacredServerStatus.running && jacredAuth && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.7rem' }}>
                {(['rutracker', 'nnmClub'] as const).map((key) => {
                  const label = key === 'rutracker' ? 'RuTracker' : 'NNM-Club';
                  const authed = jacredAuth[key];
                  return authed ? (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '10px',
                        background: 'rgba(16,245,172,0.06)',
                        border: '1px solid rgba(16,245,172,0.25)',
                        fontSize: '0.74rem',
                        fontWeight: 600,
                        color: 'var(--emerald)',
                      }}
                    >
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--emerald)', boxShadow: '0 0 8px rgba(16,245,172,0.6)', flexShrink: 0 }} />
                      {label}: авторизован ✓ — глубокий поиск включён
                    </div>
                  ) : (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '10px',
                        background: 'rgba(255,184,0,0.06)',
                        border: '1px solid rgba(255,184,0,0.25)',
                        fontSize: '0.74rem',
                        fontWeight: 600,
                        color: 'rgba(255,200,110,0.95)',
                      }}
                    >
                      <span>{label}: требуются креды для глубокого поиска</span>
                      <button
                        onClick={handleOpenJacredUi}
                        style={{
                          flexShrink: 0,
                          padding: '0.3rem 0.7rem',
                          borderRadius: '8px',
                          border: '1px solid rgba(255,184,0,0.4)',
                          background: 'rgba(255,184,0,0.1)',
                          color: '#FFC87A',
                          fontFamily: 'inherit',
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Настроить
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {/* ── RuTracker: вход ВНУТРИ приложения (поля + окно) ── */}
            {jacredServerStatus.running && (
              <div style={{ marginTop: '0.7rem', padding: '0.7rem 0.75rem', borderRadius: '12px', background: 'rgba(0,242,254,0.03)', border: '1px solid rgba(0,242,254,0.14)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.74rem', fontWeight: 800, color: 'var(--cyan)' }}>RuTracker — вход в приложении</span>
                  <span style={{
                    padding: '2px 10px', borderRadius: '999px', fontSize: '0.66rem', fontWeight: 800,
                    background: rtStatus.loggedIn ? 'rgba(16,245,172,0.1)' : 'rgba(255,184,0,0.1)',
                    border: `1px solid ${rtStatus.loggedIn ? 'rgba(16,245,172,0.35)' : 'rgba(255,184,0,0.35)'}`,
                    color: rtStatus.loggedIn ? 'var(--emerald)' : 'var(--amber)',
                  }}>
                    {rtStatus.loggedIn ? '● Сессия активна' : '○ Не вошли'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '0.45rem' }}>
                  <input
                    type="text"
                    value={rtForm.username}
                    onChange={(e) => setRtForm({ ...rtForm, username: e.target.value })}
                    placeholder="Логин RuTracker"
                    className="input-glass"
                    style={{ height: '32px', fontSize: '0.75rem', flex: 1, minWidth: 0 }}
                  />
                  <input
                    type="password"
                    value={rtForm.password}
                    onChange={(e) => setRtForm({ ...rtForm, password: e.target.value })}
                    placeholder="Пароль"
                    className="input-glass"
                    style={{ height: '32px', fontSize: '0.75rem', flex: 1, minWidth: 0 }}
                  />
                </div>
                <div style={{ display: 'flex', gap: '0.45rem' }}>
                  <button
                    onClick={handleRtSaveCreds}
                    disabled={rtBusy || !rtForm.username.trim() || !rtForm.password.trim()}
                    className="btn-secondary"
                    style={{ flex: 1, borderRadius: '9px', padding: '0.45rem', fontSize: '0.72rem', fontWeight: 700, opacity: rtBusy || !rtForm.username.trim() || !rtForm.password.trim() ? 0.5 : 1 }}
                  >
                    {rtBusy ? 'Сохранение...' : 'Сохранить креды для JacRed'}
                  </button>
                  <button
                    onClick={handleRtOpenLogin}
                    className="btn-primary"
                    style={{ flex: 1, borderRadius: '9px', padding: '0.45rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}
                  >
                    <ExternalLink size={12} />
                    {rtStatus.loginWindowOpen ? 'Окно входа открыто' : 'Войти в RuTracker'}
                  </button>
                  {rtStatus.loginWindowOpen && (
                    <button
                      onClick={handleRtHideLogin}
                      className="btn-secondary"
                      style={{ borderRadius: '9px', padding: '0.45rem 0.7rem', fontSize: '0.72rem' }}
                    >
                      Скрыть
                    </button>
                  )}
                </div>
                {rtMsg && (
                  <p style={{ fontSize: '0.68rem', lineHeight: 1.45, margin: '0.5rem 0 0', color: rtMsg.ok ? 'var(--emerald)' : 'var(--coral)' }}>
                    {rtMsg.text}
                  </p>
                )}
                <p style={{ fontSize: '0.66rem', color: 'var(--text-muted)', lineHeight: 1.45, margin: '0.45rem 0 0' }}>
                  Кнопка «Войти» откроет окно входа внутри приложения — rutracker.org блокирует
                  автоматические входы (Cloudflare), поэтому логин выполняется как на сайте.
                  После входа раздачи RuTracker с магнетами появятся в списке автоматически.
                </p>
              </div>
            )}
            {/* Ошибка запуска / подсказки */}
            {!jacredServerStatus.running && !jacredServerStatus.starting && jacredServerStatus.error && (
              <p style={{ fontSize: '0.7rem', color: 'var(--coral)', marginTop: '0.6rem', lineHeight: 1.45 }}>
                {jacredServerStatus.error}
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.7rem', lineHeight: 1.5 }}>
              Встроенный JacRed работает как TorrServer: скачивает бинарник и запускается в фоне.
              Поиск RuTracker / NNM-Club / Rutor идёт через него автоматически (первым в пуле).
              База раздач заполняется парсингом постепенно; RuTracker и NNM-Club требуют
              логин — войдите в веб-интерфейсе («Настройки JacRed»).
            </p>
          </div>

          {/* RAM Cache Selector */}
          <div>
            {sectionTitle('Буфер RAM-кэша', 'rgba(138,43,226,0.7)')}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
              {([256, 512, 1024, 2048] as const).map(mb => (
                <button
                  key={mb}
                  onClick={() => setRamCache(mb)}
                  style={{
                    padding: '0.6rem 0.4rem',
                    borderRadius: '12px',
                    border: `1px solid ${ramCache === mb ? 'rgba(138,43,226,0.5)' : 'rgba(255,255,255,0.07)'}`,
                    background: ramCache === mb ? 'rgba(138,43,226,0.15)' : 'rgba(255,255,255,0.03)',
                    color: ramCache === mb ? '#B57BFF' : 'var(--text-muted)',
                    fontFamily: 'inherit',
                    fontSize: '0.78rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                    textAlign: 'center',
                    boxShadow: ramCache === mb ? '0 0 12px rgba(138,43,226,0.25)' : 'none',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                </button>
              ))}
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.5rem', lineHeight: 1.5 }}>
              Рекомендуется 512 MB для 1080p · 1-2 GB для 4K REMUX плавного вещания
            </p>
          </div>

          {/* Audio Transcoding Toggle */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px', padding: '1.2rem' }}>
            {sectionTitle('Аудио транскодирование', 'rgba(16,245,172,0.7)')}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Микшировать AC3/DTS → Stereo AAC
                </div>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.4, maxWidth: '320px' }}>
                  Для раздач с многоканальным звуком (5.1/7.1) автоматически микширует аудио в стерео AAC.
                  Отключите, если ваш плеер поддерживает объёмный звук.
                </p>
              </div>
              <button
                onClick={() => setTranscodeAudio(!transcodeAudio)}
                style={{
                  width: '52px',
                  height: '28px',
                  borderRadius: '14px',
                  border: 'none',
                  background: transcodeAudio
                    ? 'linear-gradient(135deg, rgba(0,198,251,0.6), rgba(138,43,226,0.5))'
                    : 'rgba(255,255,255,0.1)',
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'all 0.25s ease',
                  boxShadow: transcodeAudio ? '0 0 12px rgba(0,198,251,0.3)' : 'none',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: '3px',
                    left: transcodeAudio ? '27px' : '3px',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }}
                />
              </button>
            </div>
          </div>

          {/* Jackett / Prowlarr */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px', padding: '1.2rem' }}>
            {sectionTitle('Jackett / Prowlarr (Опционально)', 'rgba(255,184,0,0.55)')}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <input
                type="text"
                value={jackettUrl}
                onChange={e => setJackettUrl(e.target.value)}
                placeholder="http://127.0.0.1:9117"
                className="input-glass"
                style={{ height: '38px', fontSize: '0.82rem' }}
              />
              <input
                type="password"
                value={jackettApiKey}
                onChange={e => setJackettApiKey(e.target.value)}
                placeholder="Jackett API Key"
                className="input-glass"
                style={{ height: '38px', fontSize: '0.82rem' }}
              />
            </div>
          </div>

          {/* VK Video & JacRed — онлайн-источники */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px', padding: '1.2rem' }}>
            {sectionTitle('Онлайн-источники', 'rgba(0,242,254,0.55)')}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.45, margin: '0' }}>
                VK Video работает без авторизации: публичный поиск по названию +
                прямые HLS-потоки (блок «Онлайн / VK» в карточке фильма).
              </p>
              <input
                type="text"
                value={jacredUrl}
                onChange={e => setJacredUrl(e.target.value)}
                placeholder="https://ваш-инстанс/jacred (свой JacRed)"
                className="input-glass"
                style={{ height: '38px', fontSize: '0.82rem' }}
              />
              <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.45, margin: '-0.2rem 0 0' }}>
                Свой JacRed-инстанс (self-hosted) — для раздач RuTracker / NNM-Club / Rutor.
                Пусто = встроенный локальный JacRed (см. карточку выше) + публичные зеркала.
              </p>
            </div>
          </div>

          {/* TMDB Key */}
          <div>
            {sectionTitle('TMDB API Ключ', 'rgba(255,184,0,0.55)')}
            <input
              type="text"
              value={tmdbKey}
              onChange={e => setTmdbKey(e.target.value)}
              placeholder="Встроенный ключ TMDB..."
              className="input-glass"
              style={{ height: '38px', fontSize: '0.82rem' }}
            />
          </div>

          {/* Footer Buttons */}
          <div style={{ display: 'flex', gap: '0.6rem', paddingTop: '0.25rem' }}>
            <button onClick={onClose} className="btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>
              Отмена
            </button>
            <button onClick={handleSave} className="btn-primary" style={{ flex: 1.5, justifyContent: 'center', borderRadius: '12px' }}>
              Сохранить настройки
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
