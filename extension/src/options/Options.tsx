import React, { useState, useEffect } from 'react';
import { Settings } from '../types';
import { getSettings, saveSettings } from '../utils/storage';

const DEFAULTS: Settings = {
  workerUrl: '',
  label: '',
  icp: '',
  minDelay: 8,
  maxDelay: 25,
  pagesPerSession: 25,
  cooldownMinutes: 7,
  dailyLimit: 800,
  workingHoursStart: 8,
  workingHoursEnd: 18,
  autoResumeAfterCooldown: true,
  autoEnrichOnComplete: true,
};

const Options: React.FC = () => {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setSettings(await getSettings());
    } catch (err) {
      setError('Failed to load settings');
      console.error(err);
    }
  };

  /**
   * The worker lives on whatever domain the operator deployed it to, so it
   * cannot be baked into the manifest. It is requested at save time from
   * optional_host_permissions instead.
   */
  const requestHostPermission = async (url: string): Promise<boolean> => {
    try {
      const parsed = new URL(url);
      // Hostname without port: match patterns apply to every port, and a
      // pattern with an explicit port would not match optional_host_permissions.
      const origin = `${parsed.protocol}//${parsed.hostname}/*`;
      return await chrome.permissions.request({ origins: [origin] });
    } catch {
      return false;
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved(false);

    if (!settings.workerUrl) {
      setError('Worker URL is required');
      return;
    }

    try {
      const parsed = new URL(settings.workerUrl);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        setError('Worker URL must use https (http is allowed only for localhost)');
        return;
      }
    } catch {
      setError('Worker URL is not a valid URL');
      return;
    }

    if (!settings.apiToken) {
      setError('API token is required — ask the worker operator to mint one for you');
      return;
    }

    if (settings.minDelay < 1) {
      setError('Minimum delay must be at least 1 second');
      return;
    }

    if (settings.maxDelay < settings.minDelay) {
      setError('Maximum delay must be greater than or equal to minimum delay');
      return;
    }

    if (settings.workingHoursStart === settings.workingHoursEnd) {
      setError('Working hours start and end must be different (overnight windows like 22 to 6 are supported)');
      return;
    }

    const permissionGranted = await requestHostPermission(settings.workerUrl);
    if (!permissionGranted) {
      setError('Permission denied — the extension needs access to your worker URL to send contacts');
      return;
    }

    try {
      await saveSettings({ ...settings, workerUrl: settings.workerUrl.replace(/\/+$/, '') });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError('Failed to save settings');
      console.error(err);
    }
  };

  /** Round-trip the worker with the configured token so a typo is caught here
   *  rather than after a 40-minute scrape. */
  const handleTestConnection = async () => {
    setTestResult('');
    setError('');

    if (!settings.workerUrl || !settings.apiToken) {
      setTestResult('Enter both the worker URL and the API token first');
      return;
    }

    const granted = await requestHostPermission(settings.workerUrl);
    if (!granted) {
      setTestResult('Permission denied for that URL');
      return;
    }

    setTesting(true);
    try {
      const base = settings.workerUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/config`, {
        headers: { Authorization: `Bearer ${settings.apiToken}` },
      });
      if (response.ok) {
        const data = (await response.json()) as { model?: string; harvestConcurrency?: number };
        setTestResult(
          `Connected. Scoring model ${data.model}, HarvestAPI concurrency ${data.harvestConcurrency}.`,
        );
      } else if (response.status === 401) {
        setTestResult('Connected to the worker, but the token was rejected (401)');
      } else {
        setTestResult(`Worker responded with HTTP ${response.status}`);
      }
    } catch (err) {
      setTestResult(`Could not reach the worker: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleInputChange = (field: keyof Settings, value: string | number | boolean) => {
    setSettings((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  return (
    <div className="options-container">
      <div className="options-header">
        <h1>SalesNav Enrichment Settings</h1>
        <p className="subtitle">Scrape Sales Navigator, enrich and score on Cloudflare, get an Excel back</p>
      </div>

      <form onSubmit={handleSave} className="options-form">
        <div className="form-section">
          <h2>Enrichment Worker</h2>

          <div className="form-group">
            <label htmlFor="workerUrl">
              Worker URL <span className="required">*</span>
            </label>
            <input
              type="url"
              id="workerUrl"
              className="form-input"
              value={settings.workerUrl}
              onChange={(e) => handleInputChange('workerUrl', e.target.value)}
              placeholder="https://salesnav-enrichment.your-subdomain.workers.dev"
              required
            />
            <p className="form-help">
              Base URL of your deployed Cloudflare worker — no trailing path.
            </p>
          </div>

          <div className="form-group">
            <label htmlFor="apiToken">
              API Token <span className="required">*</span>
            </label>
            <input
              type="password"
              id="apiToken"
              className="form-input"
              value={settings.apiToken || ''}
              onChange={(e) => handleInputChange('apiToken', e.target.value)}
              placeholder="snv_..."
              required
            />
            <p className="form-help">
              Minted by the worker operator with <code>npm run mint-token</code>. Stored locally
              on this device only — it never syncs to other Chrome profiles.
              The HarvestAPI and OpenRouter keys live in the worker and are never held here.
            </p>
          </div>

          <div className="form-group">
            <button type="button" className="btn btn-secondary" onClick={handleTestConnection} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && <p className="form-help">{testResult}</p>}
          </div>

          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              id="autoEnrichOnComplete"
              checked={settings.autoEnrichOnComplete}
              onChange={(e) => handleInputChange('autoEnrichOnComplete', e.target.checked)}
            />
            <label htmlFor="autoEnrichOnComplete" style={{ margin: 0 }}>
              Start enrichment automatically when a scraping run ends
            </label>
          </div>
        </div>

        <div className="form-section">
          <h2>Ideal Customer Profile</h2>
          <p className="section-description">
            <strong>Leave this blank to use the maintained Sokin ICP on the worker</strong> — the
            two buying motions, sector list, disqualifiers and activity signals. Only fill it in
            to score a run against something narrower (one vertical, one region, one campaign).
            Whatever you type here replaces the default entirely for this run, so include the
            disqualifiers too.
          </p>

          <div className="form-group">
            <label htmlFor="icp">Target profile override (optional)</label>
            <textarea
              id="icp"
              className="form-input"
              rows={10}
              value={settings.icp}
              onChange={(e) => handleInputChange('icp', e.target.value)}
              placeholder={
                'Blank = the full Sokin ICP maintained on the worker.\n\n' +
                'Override example — narrowing one campaign:\n\n' +
                'Sokin sells multi-currency accounts, zero-markup FX across 70+ currencies and ' +
                'instant 24/7 transfers. This run targets UK and EU EVENTS AND VENUE operators only ' +
                '(the Excel London play): Finance Directors, Heads of Finance and Financial ' +
                'Controllers at venues, promoters and event organisers with international ' +
                'exhibitors, suppliers or ticket revenue.\n\n' +
                'Disqualify: competitors (Wise, Revolut, Airwallex, Payoneer, Ebury), banks, ' +
                'consultants and agencies, job seekers, purely domestic single-currency operators.'
              }
            />
            <p className="form-help">
              Scoring returns fit score 0-100, tier A-D, buying role, signals, risks, and a
              personalized opening line grounded in the contact's profile and company record.
              The exact text used is recorded on the workbook's Run Info sheet.
            </p>
          </div>
        </div>

        <div className="form-section">
          <h2>Scraping Delays</h2>
          <p className="section-description">
            Random delays help avoid detection. The scraper waits a random time between these
            values before moving to the next page.
          </p>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="minDelay">Minimum Delay (seconds)</label>
              <input
                type="number"
                id="minDelay"
                className="form-input"
                value={settings.minDelay}
                onChange={(e) => handleInputChange('minDelay', parseInt(e.target.value))}
                min="1"
                max="60"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="maxDelay">Maximum Delay (seconds)</label>
              <input
                type="number"
                id="maxDelay"
                className="form-input"
                value={settings.maxDelay}
                onChange={(e) => handleInputChange('maxDelay', parseInt(e.target.value))}
                min="1"
                max="120"
                required
              />
            </div>
          </div>

          <p className="form-help">Recommended: 8-25 seconds</p>
        </div>

        <div className="form-section">
          <h2>Safety Limits</h2>
          <p className="section-description">
            Limits that mimic natural browsing behavior and prevent LinkedIn detection.
          </p>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="dailyLimit">Daily Profile Limit</label>
              <input
                type="number"
                id="dailyLimit"
                className="form-input"
                value={settings.dailyLimit}
                onChange={(e) => handleInputChange('dailyLimit', parseInt(e.target.value))}
                min="100"
                max="1000"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="pagesPerSession">Pages Per Session</label>
              <input
                type="number"
                id="pagesPerSession"
                className="form-input"
                value={settings.pagesPerSession}
                onChange={(e) => handleInputChange('pagesPerSession', parseInt(e.target.value))}
                min="5"
                max="100"
                required
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="cooldownMinutes">Cooldown Duration (minutes)</label>
              <input
                type="number"
                id="cooldownMinutes"
                className="form-input"
                value={settings.cooldownMinutes}
                onChange={(e) => handleInputChange('cooldownMinutes', parseInt(e.target.value))}
                min="1"
                max="30"
                required
              />
            </div>
          </div>

          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              id="autoResumeAfterCooldown"
              checked={settings.autoResumeAfterCooldown}
              onChange={(e) => handleInputChange('autoResumeAfterCooldown', e.target.checked)}
            />
            <label htmlFor="autoResumeAfterCooldown" style={{ margin: 0 }}>
              Auto-resume after cooldown
            </label>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="workingHoursStart">Working Hours Start</label>
              <input
                type="number"
                id="workingHoursStart"
                className="form-input"
                value={settings.workingHoursStart}
                onChange={(e) => handleInputChange('workingHoursStart', parseInt(e.target.value))}
                min="0"
                max="23"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="workingHoursEnd">Working Hours End</label>
              <input
                type="number"
                id="workingHoursEnd"
                className="form-input"
                value={settings.workingHoursEnd}
                onChange={(e) => handleInputChange('workingHoursEnd', parseInt(e.target.value))}
                min="0"
                max="23"
                required
              />
            </div>
          </div>

          <p className="form-help">
            Scraping outside working hours triggers a warning. Cooldown activates after each session.
          </p>
        </div>

        {error && <div className="error-message">{error}</div>}
        {saved && <div className="success-message">Settings saved successfully!</div>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary">Save Settings</button>
        </div>
      </form>

      <div className="info-section">
        <h3>How it works</h3>
        <ol>
          <li>Paste your worker URL and API token above, and describe your ICP</li>
          <li>Open a LinkedIn Sales Navigator lead list</li>
          <li>Click the extension icon, set a run label, press "Start Scraping"</li>
          <li>When the run ends, the contacts are sent to your Cloudflare worker</li>
          <li>
            The worker pulls each LinkedIn profile and the company record from HarvestAPI — no
            posts, comments or reactions — then scores every contact against your ICP
          </li>
          <li>When the job finishes, an "Excel" button appears in the popup — click to download</li>
        </ol>
        <p>
          Jobs run on Cloudflare, not in your browser. You can close the tab, close Chrome, or shut
          the laptop — the workbook will be waiting when you come back.
        </p>

        <h3>What lands in the workbook</h3>
        <ul>
          <li><strong>Scored Contacts</strong> — one row per person, best fit first: LinkedIn URL, name, job title, company (website, type, HQ, offices, LinkedIn), personalized hook, top skills, tenure, rationale and current roles</li>
          <li><strong>Run Info</strong> — job metadata, the ICP used, and data-quality counts</li>
        </ul>
      </div>
    </div>
  );
};

export default Options;
