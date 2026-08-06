import React, { useState, useEffect, useRef } from 'react';
import { ScrapingState, ScraperStatus, RunSummary, Settings } from '../types';
import { sendToBackground } from '../utils/messaging';
import { getSettings, saveSettings, getRunState, INITIAL_SCRAPING_STATE } from '../utils/storage';
import { getDailyCount, isWithinWorkingHours, getCooldownRemaining } from '../utils/safety';
import { collectScoredContacts } from '../enrichment/runner';
import { buildWorkbook, workbookFilename } from '../enrichment/xlsx';

const Popup: React.FC = () => {
  const [status, setStatus] = useState<ScraperStatus>('idle');
  const [state, setState] = useState<ScrapingState>({ ...INITIAL_SCRAPING_STATE });
  const [error, setError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');

  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState<boolean>(false);

  const [label, setLabel] = useState<string>('');
  const [pageMode, setPageMode] = useState<'all' | 'specific'>('all');
  const [pageCount, setPageCount] = useState<string>('5');

  const [dailyCount, setDailyCount] = useState<number>(0);
  const [dailyLimit, setDailyLimit] = useState<number>(800);
  const [pagesPerSession, setPagesPerSession] = useState<number>(25);
  const [cooldownRemaining, setCooldownRemaining] = useState<string>('');
  const [autoResumeEnabled, setAutoResumeEnabled] = useState<boolean>(true);
  const [selectorDegraded, setSelectorDegraded] = useState<boolean>(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Enrichment run
  const [run, setRun] = useState<RunSummary | null>(null);
  const [hasScraped, setHasScraped] = useState<boolean>(false);
  const [busy, setBusy] = useState<string>('');
  const [configured, setConfigured] = useState<boolean>(true);

  const addLog = (message: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev].slice(0, 50));
  };

  useEffect(() => {
    loadState();
    loadSettingsData();
    loadRun();

    const messageListener = (message: any) => {
      if (message.action === 'SCRAPING_STATUS') {
        setState(message.data);
        setStatus(message.data.isActive ? 'scraping' : 'idle');
        if (message.data.cooldownUntil && getCooldownRemaining(message.data.cooldownUntil) > 0) {
          startCooldownTimer(message.data.cooldownUntil);
        }
      } else if (message.action === 'SCRAPING_COMPLETE') {
        setStatus('complete');
        addLog('Scraping complete');
        setSuccessMessage(`Scraped ${message.data?.totalScraped ?? 0} profiles`);
        getDailyCount().then(setDailyCount);
        setTimeout(() => setSuccessMessage(''), 6000);
        loadRun();
      } else if (message.action === 'SCRAPING_ERROR') {
        setStatus('error');
        const errorMessage = message.data?.message || 'An error occurred';
        setError(errorMessage);
        addLog(`Error: ${errorMessage}`);
      } else if (message.action === 'ENRICHMENT_ERROR') {
        const errorMessage = message.data?.message || 'Enrichment failed';
        setError(errorMessage);
        addLog(`Enrichment: ${errorMessage}`);
        loadRun();
      } else if (message.action === 'RUN_UPDATED') {
        setRun(message.data?.run ?? null);
      } else if (message.action === 'SELECTOR_DEGRADED') {
        if (message.data?.consecutivePages >= 3) setSelectorDegraded(true);
      } else if (message.action === 'LOG_MESSAGE') {
        addLog(message.data);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    // The background broadcasts every chunk, but a popup opened mid-run needs
    // a poll to catch up if a broadcast landed while it was closed.
    const refresh = setInterval(loadRun, 5000);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      clearInterval(refresh);
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const loadState = async () => {
    try {
      const currentState = await sendToBackground<ScrapingState>('SCRAPING_STATUS');
      if (currentState) {
        setState(currentState);
        setStatus(currentState.isActive ? 'scraping' : 'idle');
        if (currentState.cooldownUntil && getCooldownRemaining(currentState.cooldownUntil) > 0) {
          startCooldownTimer(currentState.cooldownUntil);
        }
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  };

  const loadSettingsData = async () => {
    try {
      const settings = await getSettings();
      setLabel(settings.label || '');
      setDailyLimit(settings.dailyLimit);
      setPagesPerSession(settings.pagesPerSession);
      setAutoResumeEnabled(settings.autoResumeAfterCooldown);
      setConfigured(Boolean(settings.workerUrl && settings.apiToken));
      setDailyCount(await getDailyCount());
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  const loadRun = async () => {
    try {
      const payload = await sendToBackground<{ run: RunSummary | null; hasScraped: boolean }>('GET_RUN');
      if (payload) {
        setRun(payload.run);
        setHasScraped(payload.hasScraped);
      }
    } catch (err) {
      console.error('Failed to load run:', err);
    }
  };

  const startCooldownTimer = (cooldownUntil: number) => {
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    const update = () => {
      const remaining = getCooldownRemaining(cooldownUntil);
      if (remaining <= 0) {
        setCooldownRemaining('');
        if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setCooldownRemaining(`${mins}:${secs.toString().padStart(2, '0')}`);
    };
    update();
    cooldownTimerRef.current = setInterval(update, 1000);
  };

  const handleLabelChange = async (value: string) => {
    setLabel(value);
    try {
      const settings: Settings = await getSettings();
      await saveSettings({ ...settings, label: value });
    } catch (err) {
      console.error('Failed to save label:', err);
    }
  };

  const handleStartStop = async () => {
    setError('');

    if (state.isActive) {
      try {
        await sendToBackground('STOP_SCRAPING');
        setStatus('idle');
        addLog('Scraping stopped by user');
        loadRun();
      } catch {
        setError('Failed to stop scraping');
      }
      return;
    }

    try {
      const settings = await getSettings();
      if (!settings.workerUrl || !settings.apiToken) {
        setError('Configure the worker URL and API token in Settings first');
        return;
      }

      if (!isWithinWorkingHours(settings.workingHoursStart, settings.workingHoursEnd)) {
        const confirmed = window.confirm(
          `It's outside configured working hours (${settings.workingHoursStart}:00-${settings.workingHoursEnd}:00). LinkedIn activity at unusual times can trigger detection. Continue anyway?`,
        );
        if (!confirmed) {
          addLog('Scraping cancelled: outside working hours');
          return;
        }
        addLog('User confirmed scraping outside working hours');
      }

      let targetPageCount: number | null = null;
      if (pageMode === 'specific') {
        const parsed = parseInt(pageCount, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          setError('Enter a page count of 1 or more');
          return;
        }
        targetPageCount = parsed;
      }

      const result = await sendToBackground<{ success: boolean; error?: string }>('START_SCRAPING', {
        targetPageCount,
      });
      if (result?.success) {
        setStatus('scraping');
        addLog(targetPageCount ? `Scraping started (target: ${targetPageCount} pages)` : 'Scraping started (all pages)');
      } else {
        setError(result?.error || 'Failed to start scraping');
        await loadState();
      }
    } catch (err) {
      setError(`Failed to start scraping: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const runAction = async (
    action: 'START_ENRICHMENT' | 'STOP_ENRICHMENT' | 'DISCARD_RUN' | 'RESCORE_RUN',
    busyLabel: string,
  ) => {
    setError('');
    setBusy(busyLabel);
    try {
      const result = await sendToBackground<{ success: boolean; error?: string }>(action);
      if (!result?.success && result?.error) setError(result.error);
      await loadRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy('');
    }
  };

  /**
   * Build the workbook here rather than on the worker: the free Workers plan
   * caps an invocation at 10ms CPU and this takes ~500ms for 1000 contacts.
   * The popup is a normal page, so it has no CPU ceiling and URL.createObjectURL.
   */
  const handleDownload = async () => {
    setError('');
    setBusy('download');
    try {
      const runState = await getRunState();
      if (!runState || runState.enriched.length === 0) {
        setError('Nothing to export yet.');
        return;
      }

      const settings = await getSettings();
      const items = collectScoredContacts(runState);
      const buffer = await buildWorkbook(
        items,
        {
          jobId: runState.localId,
          label: runState.label,
          userId: settings.workerUrl ? new URL(settings.workerUrl).hostname : 'local',
          icp: runState.icp || '(worker default — see the worker\'s src/icp.ts)',
          model: 'worker-configured',
          createdAt: runState.startedAt,
          finishedAt: runState.finishedAt ?? new Date().toISOString(),
        },
        runState.now,
      );

      const filename = workbookFilename(runState.label, runState.localId, runState.startedAt);
      const blob = new Blob([buffer as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      addLog(`Downloaded ${filename} (${items.length} rows)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      setError(message);
      addLog(`Export failed: ${message}`);
    } finally {
      setBusy('');
    }
  };

  const getStatusText = () => {
    if (successMessage) return successMessage;
    if (run?.active) return `${run.phaseLabel} ${run.done}/${run.total}`;
    switch (status) {
      case 'scraping':
        return `Scraping page ${state.currentPage}...`;
      case 'complete':
        return 'Scraping complete';
      case 'error':
        return 'Error occurred';
      default:
        return 'Ready to scrape';
    }
  };

  const getStatusClass = () => {
    if (successMessage) return 'status-success';
    if (run?.active) return 'status-scraping';
    switch (status) {
      case 'scraping':
        return 'status-scraping';
      case 'complete':
        return 'status-complete';
      case 'error':
        return 'status-error';
      default:
        return 'status-idle';
    }
  };

  const percent = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;

  return (
    <div className="popup-container">
      <div className="popup-header">
        <h1>SalesNav Enrichment</h1>
      </div>

      <div className={`status-section ${getStatusClass()}`}>
        <div className="status-indicator"></div>
        <span className="status-text">{getStatusText()}</span>
      </div>

      {!configured && (
        <div className="error-message">
          Not configured yet — open Settings and add your worker URL and API token.
        </div>
      )}

      {error && <div className="error-message">{error}</div>}

      <div className="campaign-section">
        <label className="campaign-label" htmlFor="label-input">Run label:</label>
        <input
          id="label-input"
          type="text"
          className="campaign-input"
          value={label}
          onChange={(e) => handleLabelChange(e.target.value)}
          onBlur={(e) => handleLabelChange(e.target.value.trim())}
          placeholder="e.g. fintech-cfos-uk"
          disabled={state.isActive || run?.active}
        />
        <p className="campaign-hint">Used to name the Excel file this run produces</p>
      </div>

      <div className="campaign-section">
        <label className="campaign-label" htmlFor="page-mode-select">Pages to scrape:</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <select
            id="page-mode-select"
            className="campaign-input"
            value={pageMode}
            onChange={(e) => setPageMode(e.target.value as 'all' | 'specific')}
            disabled={state.isActive}
            style={{ flex: 1 }}
          >
            <option value="all">All available</option>
            <option value="specific">Specific number</option>
          </select>
          {pageMode === 'specific' && (
            <input
              type="number"
              min={1}
              step={1}
              className="campaign-input"
              value={pageCount}
              onChange={(e) => setPageCount(e.target.value)}
              disabled={state.isActive}
              style={{ width: '70px' }}
              aria-label="Number of pages"
            />
          )}
        </div>
      </div>

      <div className="stats-section">
        <div className="stat-item">
          <span className="stat-label">Scraped this run:</span>
          <span className="stat-value">{state.totalScraped}</span>
        </div>
        {state.isActive && (
          <div className="stat-item">
            <span className="stat-label">Current Page:</span>
            <span className="stat-value">{state.currentPage}</span>
          </div>
        )}
      </div>

      <div className="stats-section" style={{ borderTop: '1px solid #eee', paddingTop: '8px', marginTop: '4px' }}>
        <div className="stat-item">
          <span className="stat-label">Daily:</span>
          <span
            className="stat-value"
            style={{
              color:
                dailyCount / dailyLimit >= 0.85
                  ? '#e53e3e'
                  : dailyCount / dailyLimit >= 0.6
                    ? '#d69e2e'
                    : '#38a169',
            }}
          >
            {dailyCount} / {dailyLimit}
          </span>
        </div>
        {state.isActive && (
          <div className="stat-item">
            <span className="stat-label">Session Pages:</span>
            <span className="stat-value">{state.sessionPageCount} / {pagesPerSession}</span>
          </div>
        )}
      </div>

      {cooldownRemaining && (
        <div className="warning-message">
          {autoResumeEnabled
            ? `Auto-resuming in ${cooldownRemaining}...`
            : `Cooling down... ${cooldownRemaining} remaining`}
        </div>
      )}

      {selectorDegraded && (
        <div className="warning-message">
          LinkedIn may have changed their page structure. Some profiles are using fallback selectors.
        </div>
      )}

      <div className="button-section">
        <button
          className={`btn ${state.isActive ? 'btn-stop' : 'btn-start'}`}
          onClick={handleStartStop}
          disabled={run?.active}
        >
          {state.isActive ? 'Stop Scraping' : 'Start Scraping'}
        </button>

        <button className="btn btn-secondary" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>

      {/* Enrichment */}
      {(run || hasScraped) && (
        <div className="jobs-section">
          <div className="jobs-header">Enrichment</div>

          {run && (
            <div className="job-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <div className="job-main">
                <span className="job-label">{run.label}</span>
                <span className="job-meta">
                  {run.phaseLabel} · {run.done}/{run.total}
                  {run.scoredCount > 0 ? ` · ${run.scoredCount} scored` : ''}
                </span>
                {run.error && <span className="job-error">{run.error}</span>}
                <span className="job-meta">
                  {run.harvestCalls} HarvestAPI calls · {run.llmCalls} scoring calls
                </span>
              </div>
              {run.active && (
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
          )}

          {run?.active && (
            <>
              <p className="campaign-hint">
                Keep this browser open — the run stops if Chrome quits, and resumes where it left off.
              </p>
              <button
                className="btn btn-secondary"
                onClick={() => runAction('STOP_ENRICHMENT', 'stop')}
                disabled={busy !== ''}
              >
                {busy === 'stop' ? 'Stopping…' : 'Stop enrichment'}
              </button>
            </>
          )}

          {run && !run.active && run.downloadable && (
            <>
              <button className="btn btn-download" onClick={handleDownload} disabled={busy !== ''}>
                {busy === 'download' ? 'Building…' : 'Download Excel'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => runAction('RESCORE_RUN', 'rescore')}
                disabled={busy !== ''}
                title="Score these contacts again against the current model and ICP. Reuses the enrichment already paid for — no HarvestAPI calls."
              >
                {busy === 'rescore' ? 'Re-scoring…' : 'Re-score contacts'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => runAction('DISCARD_RUN', 'discard')}
                disabled={busy !== ''}
              >
                {busy === 'discard' ? 'Clearing…' : 'Clear run'}
              </button>
            </>
          )}

          {!run?.active && hasScraped && (
            <button
              className="btn btn-start"
              onClick={() => runAction('START_ENRICHMENT', 'start')}
              disabled={busy !== '' || state.isActive}
            >
              {busy === 'start' ? 'Starting…' : 'Enrich scraped contacts'}
            </button>
          )}
        </div>
      )}

      <div className="logs-section">
        <div className="logs-header">
          <button className="btn-toggle-logs" onClick={() => setShowLogs(!showLogs)}>
            {showLogs ? 'Hide' : 'Show'} Debug Logs {logs.length > 0 && `(${logs.length})`}
          </button>
          {showLogs && (
            <button
              className="btn-copy-logs"
              onClick={() => {
                navigator.clipboard.writeText(
                  [
                    '=== SalesNav Enrichment Debug Log ===',
                    `Timestamp: ${new Date().toLocaleString()}`,
                    `Status: ${status} | Active: ${state.isActive} | Page: ${state.currentPage}`,
                    `Scraped: ${state.totalScraped} | Label: ${label || 'None'}`,
                    `Run: ${run ? `${run.phase} ${run.done}/${run.total}` : 'none'}`,
                    `Error: ${error || 'None'}`,
                    '',
                    '=== Logs (newest first) ===',
                    ...logs,
                  ].join('\n'),
                );
              }}
              title="Copy all logs to clipboard"
            >
              Copy
            </button>
          )}
        </div>
        {showLogs && (
          <div className="logs-container">
            {logs.length === 0 ? (
              <div className="log-entry placeholder">No logs yet...</div>
            ) : (
              logs.map((log, index) => (
                <div key={index} className="log-entry">{log}</div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="footer">
        <small>Make sure you're on a Sales Navigator lead list page</small>
        <small className="version-text">v{chrome.runtime.getManifest().version}</small>
      </div>
    </div>
  );
};

export default Popup;
