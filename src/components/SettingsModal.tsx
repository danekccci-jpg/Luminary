import React, { useEffect, useState } from 'react';
import { X, Key, Power, Cpu, Database, RefreshCw, ScrollText, AlertTriangle } from 'lucide-react';
import logoUrl from '../assets/logo.png';
import { TorrServerStatusInfo, UserSettings } from '../types';
import { torrServerService } from '../services/torrserver';

interface SettingsModalProps {
  settings: UserSettings;
  onSaveSettings: (newSettings: UserSettings) => void;
  onClose: () => void;
  torrServerStatus: TorrServerStatusInfo;
  onRefreshStatus: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onSaveSettings,
  onClose,
  torrServerStatus,
  onRefreshStatus,
}) => {
  const [tmdbKey,       setTmdbKey]       = useState(settings.tmdbApiKey);
  const [ramCache,      setRamCache]      = useState<256 | 512 | 1024 | 2048>(settings.ramCacheMB || 512);
  const [jackettUrl,    setJackettUrl]    = useState(settings.jackettUrl || '');
  const [jackettApiKey, setJackettApiKey] = useState(settings.jackettApiKey || '');
  const [transcodeAudio, setTranscodeAudio] = useState(settings.transcodeAudioToAac ?? true);
  const [platformInfo,  setPlatformInfo]  = useState({ platform: 'desktop', arch: 'x64' });
  const [isToggling,    setIsToggling]    = useState(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSave = () => {
    onSaveSettings({ ...settings, tmdbApiKey: tmdbKey, ramCacheMB: ramCache, jackettUrl, jackettApiKey, transcodeAudioToAac: transcodeAudio });
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
