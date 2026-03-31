import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import cytoscape from 'cytoscape';
import './App.css';

// Set JWT token on axios if available
const savedToken = localStorage.getItem('authToken');
if (savedToken) {
  axios.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-content">
            <h2>Something went wrong</h2>
            <p>An unexpected error occurred. Please refresh the page to try again.</p>
            <button onClick={() => window.location.reload()}>Refresh Page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthScreen({ onAuth }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const API = import.meta.env.VITE_API_URL || '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
      const res = await axios.post(`${API}${endpoint}`, { email, password });
      if (res.data.success) {
        localStorage.setItem('authToken', res.data.token);
        axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
        onAuth(res.data);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">O2C</div>
        <h2 className="auth-title">Insight Engine</h2>
        <p className="auth-subtitle">{isLogin ? 'Sign in to your account' : 'Create a new account'}</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="auth-input"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="auth-input"
          />
          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {error && <div className="auth-error">{error}</div>}

        <div className="auth-switch">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button className="auth-switch-btn" onClick={() => { setIsLogin(!isLogin); setError(null); }}>
            {isLogin ? 'Sign up' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [authToken, setAuthToken] = useState(localStorage.getItem('authToken'));
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resultInfo, setResultInfo] = useState(null);
  const [chatHistory, setChatHistory] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [showLabels, setShowLabels] = useState(true);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [showSql, setShowSql] = useState(false);
  const [datasetInfo, setDatasetInfo] = useState(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [uploadMode, setUploadMode] = useState('config');
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [onboardingSession, setOnboardingSession] = useState(null);
  const [editedTables, setEditedTables] = useState(null);
  const [editedRelationships, setEditedRelationships] = useState(null);
  const [datasetName, setDatasetName] = useState('');
  const [providerHealth, setProviderHealth] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [docUploadStatus, setDocUploadStatus] = useState(null);
  const docFileInputRef = useRef(null);

  const cyRef = useRef(null);
  const cyContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const isDraggingTooltip = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const fileInputRef = useRef(null);
  const rawFileInputRef = useRef(null);
  const abortControllerRef = useRef(null);

  const API_BASE = import.meta.env.VITE_API_URL || '';

  const [datasetError, setDatasetError] = useState(false);

  const fetchDatasetInfo = () => {
    setDatasetError(false);
    axios.get(`${API_BASE}/api/dataset`)
      .then(r => setDatasetInfo(r.data))
      .catch(() => setDatasetError(true));
  };

  const fetchProviderHealth = () => {
    axios.get(`${API_BASE}/api/providers`)
      .then(r => setProviderHealth(r.data))
      .catch(() => {});
  };

  // Fetch active dataset metadata + provider health on mount
  useEffect(() => {
    fetchDatasetInfo();
    fetchProviderHealth();
    // Refresh provider health every 30s
    const interval = setInterval(fetchProviderHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  // Refresh provider health after each query
  useEffect(() => {
    if (!isLoading && resultInfo) {
      fetchProviderHealth();
    }
  }, [isLoading]);

  const handleDatasetUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadStatus('loading');

    try {
      const text = await file.text();
      let config;
      try {
        config = JSON.parse(text);
      } catch {
        setUploadStatus({ success: false, message: 'Invalid JSON file. Please upload a valid dataset config.' });
        return;
      }

      const res = await axios.post(`${API_BASE}/api/dataset/upload`, { config }, { timeout: 120000 });

      if (res.data.success) {
        setUploadStatus({
          success: true,
          message: `Dataset "${res.data.dataset}" loaded — ${res.data.tablesCreated} tables, ${res.data.rowsLoaded} rows.`
        });
        fetchDatasetInfo();
        setChatHistory([]);
        setResultInfo(null);
        setSelectedNode(null);
        if (cyRef.current) { cyRef.current.destroy(); cyRef.current = null; }
      } else {
        setUploadStatus({ success: false, message: res.data.error?.message || 'Upload failed.' });
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Upload failed.';
      setUploadStatus({ success: false, message: msg });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRawUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploadStatus('loading');
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }

      const res = await axios.post(`${API_BASE}/api/dataset/upload/raw`, formData, {
        timeout: 120000,
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (res.data.success) {
        setOnboardingSession(res.data.sessionId);
        setEditedTables(res.data.schema.tables);
        setEditedRelationships(res.data.relationships.map(r => ({ ...r, accepted: r.confidence >= 0.5 })));
        setDatasetName('');
        setOnboardingStep(1);
        setUploadStatus(null);
      } else {
        setUploadStatus({ success: false, message: res.data.error?.message || 'Upload failed.' });
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Upload failed.';
      setUploadStatus({ success: false, message: msg });
    } finally {
      if (rawFileInputRef.current) rawFileInputRef.current.value = '';
    }
  };

  const handleConfirmOnboarding = async () => {
    if (!datasetName.trim()) {
      setUploadStatus({ success: false, message: 'Please enter a dataset name.' });
      return;
    }

    setUploadStatus('loading');
    try {
      const acceptedRels = (editedRelationships || [])
        .filter(r => r.accepted)
        .map(({ accepted, ...rest }) => rest);

      const res = await axios.post(`${API_BASE}/api/dataset/upload/confirm`, {
        sessionId: onboardingSession,
        name: datasetName.trim(),
        tables: editedTables,
        relationships: acceptedRels
      }, { timeout: 120000 });

      if (res.data.success) {
        setUploadStatus({
          success: true,
          message: `Dataset "${res.data.dataset}" loaded — ${res.data.tablesCreated} tables, ${res.data.rowsLoaded} rows.`
        });
        fetchDatasetInfo();
        setChatHistory([]);
        setResultInfo(null);
        setSelectedNode(null);
        if (cyRef.current) { cyRef.current.destroy(); cyRef.current = null; }
        setOnboardingStep(0);
        setOnboardingSession(null);
      } else {
        setUploadStatus({ success: false, message: res.data.error?.message || 'Confirmation failed.' });
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Confirmation failed.';
      setUploadStatus({ success: false, message: msg });
    }
  };

  const resetOnboarding = () => {
    setOnboardingStep(0);
    setOnboardingSession(null);
    setEditedTables(null);
    setEditedRelationships(null);
    setDatasetName('');
    setUploadStatus(null);
  };

  const fetchDocuments = () => {
    axios.get(`${API_BASE}/api/documents`)
      .then(r => {
        if (r.data.success) setDocuments(r.data.documents || []);
      })
      .catch(() => {});
  };

  const handleDocumentUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDocUploadStatus('loading');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', file.name.replace(/\.[^.]+$/, ''));

      const res = await axios.post(`${API_BASE}/api/documents/upload`, formData, {
        timeout: 300000,
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (res.data.success) {
        setDocUploadStatus({ success: true, message: `"${res.data.title}" uploaded — ${res.data.chunkCount} chunks created.` });
        fetchDocuments();
      } else {
        setDocUploadStatus({ success: false, message: res.data.error?.message || 'Upload failed.' });
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Upload failed.';
      setDocUploadStatus({ success: false, message: msg });
    } finally {
      if (docFileInputRef.current) docFileInputRef.current.value = '';
    }
  };

  const handleDeleteDocument = async (id) => {
    try {
      await axios.delete(`${API_BASE}/api/documents/${id}`);
      fetchDocuments();
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  useEffect(() => {
    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
      }
    };
  }, []);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [resultInfo, error, isLoading]);

  // Tooltip drag handlers
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDraggingTooltip.current) return;
      e.preventDefault();
      setTooltipPos({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y
      });
    };
    const handleMouseUp = () => {
      isDraggingTooltip.current = false;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleTooltipDragStart = (e) => {
    isDraggingTooltip.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  // Compute provider health summary
  const getProviderSummary = () => {
    if (!providerHealth) return { active: 0, total: 0, healthy: 0 };
    const entries = Object.values(providerHealth);
    const active = entries.filter(p => p.active);
    const healthy = active.filter(p => !p.cooldown && p.consecutiveFailures === 0);
    return { active: active.length, total: entries.length, healthy: healthy.length };
  };

  const providerSummary = getProviderSummary();

  // Dynamic welcome examples based on dataset
  const getWelcomeExamples = () => {
    if (!datasetInfo) return [];
    if (datasetInfo.name === 'sap_o2c') {
      return [
        'Trace full flow for billing document 90504204',
        'Top 5 customers by billing amount',
        'Show all cancelled billing documents',
        'Count all delivery documents',
      ];
    }
    // Generate diverse examples from table names
    const tables = (datasetInfo.tables || []).slice(0, 5);
    const examples = [];
    const name = (t) => t.displayName || t.name.replace(/_/g, ' ');
    if (tables.length > 0) examples.push(`Top 5 ${name(tables[0])} by count`);
    if (tables.length > 1) examples.push(`Show all ${name(tables[1])}`);
    if (tables.length > 2) examples.push(`Count all ${name(tables[2])}`);
    if (tables.length > 3) examples.push(`Find ${name(tables[3])} with details`);
    return examples;
  };

  const initCytoscape = (graph, highlightNodes) => {
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const elements = [
      ...graph.nodes.map(n => ({ data: n })),
      ...graph.edges.map(e => ({ data: e }))
    ];

    if (elements.length === 0) return;

    cyRef.current = cytoscape({
      container: cyContainerRef.current,
      elements: elements,
      maxZoom: 2.5,
      minZoom: 0.3,
      style: [
        {
          selector: 'node',
          style: {
            'width': 10,
            'height': 10,
            'background-color': '#c8b4d4',
            'border-width': 1.5,
            'border-color': '#c8b4d4',
            'background-opacity': 0.3,
            'shape': 'ellipse',
            'label': '',
            'overlay-padding': '3px'
          }
        },
        {
          selector: 'node:selected',
          style: {
            'width': 14,
            'height': 14,
            'border-width': 2.5,
            'background-opacity': 0.9,
            'label': 'data(label)',
            'text-wrap': 'wrap',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'font-size': '8px',
            'color': '#1a1a2e',
            'text-max-width': '80px'
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 0.8,
            'line-color': '#a8bce0',
            'target-arrow-color': '#a8bce0',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.5,
            'curve-style': 'bezier',
            'label': 'data(type)',
            'font-size': '7px',
            'text-rotation': 'autorotate',
            'text-background-opacity': 1,
            'text-background-color': '#f7f8fa',
            'text-background-padding': '1px',
            'color': '#a0a8c0',
            'opacity': 0.5
          }
        },
        { selector: 'edge.hide-label', style: { 'label': '' } },
        { selector: 'node[type="SalesOrder"]', style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' } },
        { selector: 'node[type="Delivery"]', style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' } },
        { selector: 'node[type="BillingDocument"]', style: { 'background-color': '#e87c8a', 'border-color': '#e87c8a' } },
        { selector: 'node[type="JournalEntry"]', style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' } },
        { selector: 'node[type="Payment"]', style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' } },
        { selector: 'node[type="Customer"]', style: { 'background-color': '#e87c8a', 'border-color': '#e87c8a' } },
        {
          selector: 'node[type="Aggregation"], node[type="Company"], node[type="Product"], node[type="Plant"], node[type="Document"]',
          style: { 'background-color': '#e87c8a', 'border-color': '#e87c8a' }
        }
      ],
      layout: {
        name: 'breadthfirst',
        directed: true,
        padding: 60,
        spacingFactor: 1.5,
        animate: true,
        animationDuration: 400,
        fit: true,
        avoidOverlap: true
      }
    });

    cyRef.current.on('tap', 'node', (evt) => {
      cyRef.current.nodes().deselect();
      evt.target.select();

      const container = cyContainerRef.current;
      const pos = evt.renderedPosition;
      const tooltipW = 320;
      const tooltipH = 350;
      const cw = container ? container.offsetWidth : 800;
      const ch = container ? container.offsetHeight : 600;

      let x = pos.x + 20;
      let y = pos.y + 20;
      if (x + tooltipW > cw) x = pos.x - tooltipW - 10;
      if (y + tooltipH > ch) y = Math.max(10, ch - tooltipH - 10);
      if (y < 10) y = 10;

      setSelectedNode({ data: evt.target.data() });
      setTooltipPos({ x, y });
    });

    cyRef.current.on('tap', (evt) => {
      if (evt.target === cyRef.current) {
        cyRef.current.nodes().deselect();
        setSelectedNode(null);
      }
    });

    if (!showLabels && cyRef.current) {
      cyRef.current.edges().addClass('hide-label');
    }

    if (highlightNodes && highlightNodes.length > 0) {
      cyRef.current.nodes().forEach(node => {
        if (highlightNodes.includes(node.id())) {
          node.style({
            'width': 16,
            'height': 16,
            'border-width': 3,
            'background-opacity': 0.9,
            'border-color': '#1a1a2e'
          });
        }
      });
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);
    setResultInfo(null);
    setSelectedNode(null);
    const currentQuery = query.trim();
    setQuery('');

    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await axios.post(`${API_BASE}/api/query`, { query: currentQuery, includeSql: showSql }, { timeout: 120000, signal: controller.signal });
      const { success, requestId, traceId, dataset, queryType, rowCount, executionTimeMs, graph, reason, resultStatus, suggestions, summary, highlightNodes: hl, nlAnswer, sql, explanation, confidence, confidenceLabel, confidenceReasons, executionPlan, queryPlan, complexity, truncated, message, metrics, dataConfidence } = response.data;

      if (success) {
        const info = {
          requestId,
          dataset: dataset || null,
          queryType: queryType || null,
          rowCount,
          executionTimeMs: Number(executionTimeMs).toFixed(2),
          hasNodes: graph && graph.nodes && graph.nodes.length > 0,
          reason,
          suggestions,
          summary,
          nlAnswer: nlAnswer || null,
          sql: sql || null,
          explanation: explanation || null,
          confidence: confidence ?? null,
          confidenceLabel: confidenceLabel || null,
          confidenceReasons: confidenceReasons || [],
          executionPlan: executionPlan || null,
          queryPlan: queryPlan || null,
          resultStatus: resultStatus || null,
          complexity: complexity || null,
          truncated: truncated || false,
          message: message || null,
          traceId: traceId || null,
          metrics: metrics || null,
          dataConfidence: dataConfidence || null
        };
        setResultInfo(info);
        setChatHistory(prev => [...prev, { type: 'user', text: currentQuery }, { type: 'agent', info }]);
        initCytoscape(graph, hl || []);
      }
    } catch (err) {
      if (axios.isCancel(err) || err.name === 'CanceledError') return;
      console.error(err);
      let errMsg = 'An error occurred connecting to the API.';
      if (err.code === 'ECONNABORTED') {
        errMsg = 'Request timed out. The server took too long to respond — please try again.';
      } else if (err.response?.data?.error) {
        errMsg = typeof err.response.data.error === 'object'
          ? err.response.data.error.message
          : err.response.data.error;
      } else if (err.message) {
        errMsg = err.message;
      }
      setError(errMsg);
      setChatHistory(prev => [...prev, { type: 'user', text: currentQuery }, { type: 'error', text: errMsg }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch(e);
    }
  };

  const handleFitGraph = () => {
    if (cyRef.current) {
      cyRef.current.fit(undefined, 50);
    }
  };

  const handleToggleLabels = () => {
    setShowLabels(prev => {
      const next = !prev;
      if (cyRef.current) {
        if (next) {
          cyRef.current.edges().removeClass('hide-label');
        } else {
          cyRef.current.edges().addClass('hide-label');
        }
      }
      return next;
    });
  };

  const dsName = datasetError ? 'Connection Error' : (datasetInfo?.displayName || 'Loading...');
  const dsShort = datasetInfo?.name
    ? datasetInfo.name.replace(/_/g, ' ').split(' ').map(w => w[0]?.toUpperCase()).join('')
    : datasetError ? '!' : '...';

  // Badge helpers
  const queryTypeBadgeClass = (type) => {
    const t = (type || '').toLowerCase();
    if (t === 'sql') return 'badge-sql';
    if (t === 'rag') return 'badge-rag';
    if (t === 'hybrid') return 'badge-hybrid';
    return 'badge-fallback';
  };

  const complexityBadgeClass = (level) => {
    const l = (level || '').toLowerCase();
    if (l === 'simple') return 'badge-simple';
    if (l === 'moderate') return 'badge-moderate';
    if (l === 'complex') return 'badge-complex';
    return '';
  };

  const planBadgeClass = (plan) => {
    const p = (plan || '').toLowerCase();
    if (p === 'rule_based') return 'badge-rule';
    if (p === 'llm') return 'badge-llm';
    if (p === 'fallback' || p === 'fallback_sql') return 'badge-fallback-plan';
    return 'badge-fallback-plan';
  };

  // Provider health dot color
  const providerDotColor = () => {
    if (!providerHealth) return '#c0c0d0'; // unknown
    if (providerSummary.healthy === 0) return '#ef4444'; // all down
    if (providerSummary.healthy < providerSummary.active) return '#f59e0b'; // degraded
    return '#34d399'; // healthy
  };

  const handleAuth = (data) => {
    setAuthToken(data.token);
  };

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    delete axios.defaults.headers.common['Authorization'];
    setAuthToken(null);
    setChatHistory([]);
    setResultInfo(null);
    setDatasetInfo(null);
  };

  // Auth gate — show login/register if not authenticated
  if (!authToken) {
    return (
      <ErrorBoundary>
        <AuthScreen onAuth={handleAuth} />
      </ErrorBoundary>
    );
  }

  return (
    <div className="app-container">
      {/* TOP NAV */}
      <div className="top-nav">
        <div className="nav-logo">O2C</div>
        <div className="nav-breadcrumb">
          Insight Engine <span className="nav-separator">/</span> <span className="nav-active">{dsName}</span>
        </div>
        {datasetInfo && (
          <div className="nav-dataset-badge">
            {datasetInfo.tableCount} tables
          </div>
        )}

        {/* Provider health indicator */}
        {providerHealth && (
          <div className="nav-provider-status" title={`${providerSummary.healthy}/${providerSummary.active} providers healthy`}>
            <span className="provider-dot" style={{ background: providerDotColor() }}></span>
            <span className="provider-label">
              {providerSummary.healthy}/{providerSummary.active} AI
            </span>
          </div>
        )}

        {datasetError && (
          <button className="nav-dataset-badge" style={{ cursor: 'pointer', color: '#b91c1c' }} onClick={fetchDatasetInfo}>
            Retry Connection
          </button>
        )}
        <button className="nav-upload-btn" onClick={() => { resetOnboarding(); setShowUploadModal(true); }}>
          Switch Dataset
        </button>
        <button className="nav-logout-btn" onClick={handleLogout} title="Sign out">
          Logout
        </button>
      </div>

      {/* Dataset Upload Modal */}
      {showUploadModal && (
        <div className="modal-overlay" onClick={() => setShowUploadModal(false)}>
          <div className={`modal-content ${uploadMode === 'raw' && onboardingStep > 0 ? 'modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Switch Dataset</h3>
              <button className="modal-close" onClick={() => setShowUploadModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              {/* Mode Toggle */}
              <div className="upload-mode-toggle">
                <button className={`mode-btn ${uploadMode === 'config' ? 'active' : ''}`} onClick={() => { setUploadMode('config'); resetOnboarding(); }}>
                  Upload Config
                </button>
                <button className={`mode-btn ${uploadMode === 'raw' ? 'active' : ''}`} onClick={() => { setUploadMode('raw'); resetOnboarding(); }}>
                  Upload Raw Data
                </button>
                <button className={`mode-btn ${uploadMode === 'documents' ? 'active' : ''}`} onClick={() => { setUploadMode('documents'); resetOnboarding(); setDocUploadStatus(null); fetchDocuments(); }}>
                  Documents
                </button>
              </div>

              {/* Config Mode */}
              {uploadMode === 'config' && (
                <>
                  <p className="modal-description">
                    Upload a JSON config file to switch the active dataset. The config must include
                    <strong> name</strong>, <strong>tables</strong> (with columns), <strong>relationships</strong>,
                    and <strong>domainKeywords</strong>.
                  </p>
                  <label className="file-upload-label">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json"
                      onChange={handleDatasetUpload}
                      disabled={uploadStatus === 'loading'}
                      className="file-input-hidden"
                    />
                    <span className="file-upload-btn">
                      {uploadStatus === 'loading' ? 'Uploading...' : 'Choose JSON Config File'}
                    </span>
                  </label>
                </>
              )}

              {/* Raw Data Mode */}
              {uploadMode === 'raw' && onboardingStep === 0 && (
                <>
                  <p className="modal-description">
                    Upload your data files (JSONL, CSV, or ZIP containing multiple files). The system will automatically detect the schema
                    and suggest relationships between tables.
                  </p>
                  <label className="file-upload-label">
                    <input
                      ref={rawFileInputRef}
                      type="file"
                      multiple
                      accept=".jsonl,.csv,.json,.zip"
                      onChange={handleRawUpload}
                      disabled={uploadStatus === 'loading'}
                      className="file-input-hidden"
                    />
                    <span className="file-upload-btn">
                      {uploadStatus === 'loading' ? 'Analyzing files...' : 'Choose Data Files'}
                    </span>
                  </label>
                </>
              )}

              {/* Step 1: Schema Review */}
              {uploadMode === 'raw' && onboardingStep === 1 && editedTables && (
                <div className="onboarding-step">
                  <div className="step-indicator">
                    <span className="step-dot active">1</span>
                    <span className="step-line"></span>
                    <span className="step-dot">2</span>
                  </div>
                  <h4>Review Detected Schema</h4>
                  <p className="modal-description">Edit table names, remove unwanted columns, or adjust primary keys.</p>
                  <div className="schema-tables-list">
                    {editedTables.map((table, ti) => (
                      <div key={ti} className="schema-table-card">
                        <div className="table-card-header">
                          <input
                            className="table-name-input"
                            value={table.displayName || table.name}
                            onChange={(e) => {
                              const updated = [...editedTables];
                              updated[ti] = { ...updated[ti], displayName: e.target.value };
                              setEditedTables(updated);
                            }}
                          />
                          <span className="table-record-count">{table.recordCount} rows</span>
                        </div>
                        <div className="table-pk">
                          PK: {table.primaryKey?.length > 0 ? (
                            <select
                              value={table.primaryKey[0]}
                              onChange={(e) => {
                                const updated = [...editedTables];
                                updated[ti] = { ...updated[ti], primaryKey: [e.target.value] };
                                setEditedTables(updated);
                              }}
                            >
                              {table.columns.map(col => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                          ) : <span className="pk-none">None detected</span>}
                        </div>
                        <div className="table-columns">
                          {table.columns.map((col, ci) => (
                            <span key={ci} className="chip">
                              {col}
                              <button className="chip-remove" onClick={() => {
                                const updated = [...editedTables];
                                const newCols = updated[ti].columns.filter((_, i) => i !== ci);
                                updated[ti] = { ...updated[ti], columns: newCols };
                                setEditedTables(updated);
                              }}>&times;</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="onboarding-actions">
                    <button className="btn-secondary" onClick={resetOnboarding}>Back</button>
                    <button className="btn-primary" onClick={() => setOnboardingStep(2)}>Next: Relationships</button>
                  </div>
                </div>
              )}

              {/* Step 2: Relationship Review */}
              {uploadMode === 'raw' && onboardingStep === 2 && (
                <div className="onboarding-step">
                  <div className="step-indicator">
                    <span className="step-dot completed">1</span>
                    <span className="step-line"></span>
                    <span className="step-dot active">2</span>
                  </div>
                  <h4>Review Suggested Relationships</h4>
                  <p className="modal-description">Accept or reject the detected relationships.</p>

                  {editedRelationships && editedRelationships.length > 0 ? (
                    <div className="relationships-list">
                      {editedRelationships.map((rel, ri) => (
                        <div key={ri} className={`relationship-card ${rel.accepted ? 'accepted' : 'rejected'}`}>
                          <label className="rel-checkbox">
                            <input
                              type="checkbox"
                              checked={rel.accepted}
                              onChange={() => {
                                const updated = [...editedRelationships];
                                updated[ri] = { ...updated[ri], accepted: !updated[ri].accepted };
                                setEditedRelationships(updated);
                              }}
                            />
                          </label>
                          <div className="rel-info">
                            <div className="rel-path">{rel.from} &rarr; {rel.to}</div>
                            <div className="rel-meta">
                              <span className="rel-label-tag">{rel.label}</span>
                              <span className="rel-join">{rel.joinType}</span>
                              <span className={`rel-level rel-level-${rel.level || (rel.confidence > 0.8 ? 'strong' : 'medium')}`}>
                                {rel.level || (rel.confidence > 0.8 ? 'strong' : 'medium')}
                              </span>
                            </div>
                            <div className="rel-reason">{rel.reason}</div>
                          </div>
                          <div className="confidence-bar-wrap">
                            <div className={`confidence-bar confidence-${rel.level || (rel.confidence > 0.8 ? 'strong' : 'medium')}`} style={{ width: `${Math.round(rel.confidence * 100)}%` }}></div>
                            <span className="confidence-pct">{Math.round(rel.confidence * 100)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="no-relationships">
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>No relationships detected</div>
                      <div>Your tables will be loaded independently. You can still query each table individually.</div>
                    </div>
                  )}

                  <div className="dataset-name-input">
                    <label>Dataset Name</label>
                    <input
                      type="text"
                      placeholder="e.g. my_sales_data"
                      value={datasetName}
                      onChange={(e) => setDatasetName(e.target.value)}
                    />
                  </div>

                  <div className="onboarding-actions">
                    <button className="btn-secondary" onClick={() => setOnboardingStep(1)}>Back</button>
                    <button className="btn-primary" onClick={handleConfirmOnboarding} disabled={uploadStatus === 'loading'}>
                      {uploadStatus === 'loading' ? 'Loading...' : 'Confirm & Load'}
                    </button>
                  </div>
                </div>
              )}

              {/* Documents Mode */}
              {uploadMode === 'documents' && (
                <div className="documents-section">
                  <p className="modal-description">
                    Upload documents (PDF, TXT, MD, DOCX) to enhance the knowledge base. RAG queries will search these documents for context.
                  </p>
                  <label className="file-upload-label">
                    <input
                      ref={docFileInputRef}
                      type="file"
                      accept=".pdf,.txt,.md,.docx"
                      onChange={handleDocumentUpload}
                      disabled={docUploadStatus === 'loading'}
                      className="file-input-hidden"
                    />
                    <span className="file-upload-btn">
                      {docUploadStatus === 'loading' ? 'Processing document...' : 'Upload Document'}
                    </span>
                  </label>

                  {docUploadStatus && docUploadStatus !== 'loading' && (
                    <div className={`upload-status ${docUploadStatus.success ? 'upload-success' : 'upload-error'}`}>
                      {docUploadStatus.message}
                    </div>
                  )}
                  {docUploadStatus === 'loading' && (
                    <div className="upload-status upload-loading">
                      <div className="dot-pulse"><span></span><span></span><span></span></div>
                      Extracting, chunking & embedding document...
                    </div>
                  )}

                  {documents.length > 0 ? (
                    <div className="document-list">
                      {documents.map(doc => (
                        <div key={doc.id} className="document-card">
                          <div className="document-info">
                            <span className="doc-chip">{doc.file_type.toUpperCase()}</span>
                            <span className="document-title">{doc.title}</span>
                            <span className="document-meta">{doc.chunk_count} chunks</span>
                          </div>
                          <button className="doc-delete-btn" onClick={() => handleDeleteDocument(doc.id)} title="Delete document">&times;</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="no-documents">No documents uploaded yet. Upload documents to enable vector-powered RAG answers.</div>
                  )}
                  <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => setShowUploadModal(false)}>Done</button>
                </div>
              )}

              {/* Status Messages */}
              {uploadStatus && uploadStatus !== 'loading' && (
                <div className={`upload-status ${uploadStatus.success ? 'upload-success' : 'upload-error'}`}>
                  {uploadStatus.message}
                </div>
              )}
              {uploadStatus === 'loading' && (
                <div className="upload-status upload-loading">
                  <div className="dot-pulse"><span></span><span></span><span></span></div>
                  {onboardingStep === 0 ? 'Analyzing files...' : 'Initializing dataset...'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="main-content">
        {/* GRAPH PANEL (LEFT) */}
        <div className="graph-panel">
          <div ref={cyContainerRef} className="cy-container" />

          <div className="graph-overlay-buttons">
            <button className="overlay-btn" onClick={handleFitGraph} disabled={!cyRef.current}>
              <span className="btn-icon">&#8596;</span> Fit View
            </button>
            <button className="overlay-btn" onClick={handleToggleLabels}>
              <span className="btn-icon">&#9783;</span> {showLabels ? 'Hide Labels' : 'Show Labels'}
            </button>
          </div>

          {/* Empty graph state */}
          {(!resultInfo || (resultInfo && !resultInfo.hasNodes)) && !isLoading && (
            <div className="graph-empty-state">
              <div className="empty-icon">&#9672;</div>
              {!resultInfo && <div>Ask a question to visualize the graph</div>}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'INVALID_ID' && (
                <div className="empty-error">Document not found in the dataset</div>
              )}
              {resultInfo && !resultInfo.hasNodes && ['NO_FLOW', 'INCOMPLETE_FLOW', 'NO_DATA', 'NO_GAPS'].includes(resultInfo.reason) && (
                <div className={resultInfo.resultStatus === 'NO_GAPS_FOUND' ? 'empty-info' : 'empty-warn'}>
                  {{ NO_GAPS_FOUND: 'No gaps detected — all flows are complete',
                     INCOMPLETE_FLOW: 'Incomplete document flow — some stages are missing',
                     NO_MATCH: 'No matching data found'
                  }[resultInfo.resultStatus] || 'No connected flow found'}
                </div>
              )}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'AGGREGATION' && (
                <div className="empty-info">Aggregation results shown in chat</div>
              )}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'RAG_RESPONSE' && (
                <div className="empty-info">Knowledge base answer shown in chat</div>
              )}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'LLM_UNAVAILABLE' && (
                <div className="empty-warn">AI providers temporarily unavailable</div>
              )}
              {resultInfo && !resultInfo.hasNodes && !['INVALID_ID','NO_FLOW','INCOMPLETE_FLOW','NO_DATA','NO_GAPS','AGGREGATION','RAG_RESPONSE','LLM_UNAVAILABLE'].includes(resultInfo.reason) && (
                <div>No graph data available</div>
              )}
            </div>
          )}

          {/* Node Tooltip */}
          {selectedNode && selectedNode.data.properties && (() => {
            const entries = Object.entries(selectedNode.data.properties);
            const MAX_VISIBLE = 15;
            const visible = entries.slice(0, MAX_VISIBLE);
            const hiddenCount = entries.length - MAX_VISIBLE;
            const connections = cyRef.current ? cyRef.current.getElementById(selectedNode.data.id).connectedEdges().length : 0;

            return (
              <div
                className="node-tooltip"
                style={{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }}
                onMouseDown={handleTooltipDragStart}
              >
                <h4>{selectedNode.data.type || 'Entity'}</h4>
                <div className="tooltip-body">
                  {visible.map(([key, val]) => (
                    <div key={key} className="tooltip-line">
                      <span className="tooltip-key">{key}:</span> {val?.toString() || ''}
                    </div>
                  ))}
                  {hiddenCount > 0 && (
                    <div className="tooltip-hidden">+{hiddenCount} more fields</div>
                  )}
                  <div className="tooltip-connections">Connections: {connections}</div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* CHAT PANEL (RIGHT) */}
        <div className="chat-panel">
          <div className="chat-header">
            <div className="chat-title">Chat with Graph</div>
            <div className="chat-subtitle">{dsName}</div>
          </div>

          <div className="agent-identity">
            <div className="agent-avatar">{dsShort}</div>
            <div className="agent-info">
              <div className="agent-name">Graph Agent</div>
              <div className="agent-role">{dsName} Analyst</div>
            </div>
          </div>

          <div className="chat-messages">
            <div className="chat-welcome">
              Hi! I can help you analyze the <strong>{dsName}</strong> dataset. Try asking:
              <ul className="welcome-examples">
                {getWelcomeExamples().map((ex, i) => (
                  <li key={i}>
                    <button className="welcome-example-btn" onClick={() => setQuery(ex)}>{ex}</button>
                  </li>
                ))}
              </ul>
            </div>

            {/* Conversation History */}
            {chatHistory.map((msg, i) => {
              if (msg.type === 'user') {
                return (
                  <div key={i} className="chat-user-msg">
                    <span className="chat-user-label">You</span>
                    <div className="chat-user-bubble">{msg.text}</div>
                  </div>
                );
              }
              if (msg.type === 'error') {
                return <div key={i} className="chat-error">{msg.text}</div>;
              }
              if (msg.type === 'agent' && msg.info) {
                const r = msg.info;
                return (
                  <div key={i} className="chat-response">
                    {/* NL Answer */}
                    {r.nlAnswer && (
                      <div className="chat-agent-msg">
                        <div className="chat-agent-header">
                          <div className="agent-avatar-sm">{dsShort}</div>
                          <span className="agent-name-sm">Graph Agent</span>
                        </div>
                        <div className="chat-agent-bubble">{r.nlAnswer}</div>
                      </div>
                    )}

                    {/* Summary fallback (no NL answer) */}
                    {!r.nlAnswer && r.summary && (
                      <div className={
                        r.reason === 'INVALID_ID' ? 'chat-error' :
                        ['NO_FLOW','INCOMPLETE_FLOW','NO_DATA','NO_GAPS','LLM_UNAVAILABLE'].includes(r.reason) ? 'chat-info' :
                        'chat-agent-msg'
                      }>
                        {r.reason === 'INVALID_ID' || ['NO_FLOW','INCOMPLETE_FLOW','NO_DATA','NO_GAPS','LLM_UNAVAILABLE'].includes(r.reason) ? (
                          r.summary
                        ) : (
                          <>
                            <div className="chat-agent-header">
                              <div className="agent-avatar-sm">{dsShort}</div>
                              <span className="agent-name-sm">Graph Agent</span>
                            </div>
                            <div className="chat-agent-bubble">{r.summary}</div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Zero-data message */}
                    {r.message && !r.nlAnswer && r.reason !== 'LLM_UNAVAILABLE' && (
                      <div className="chat-info">{r.message}</div>
                    )}

                    {/* Suggestion chips — for INVALID_ID */}
                    {r.reason === 'INVALID_ID' && r.suggestions && r.suggestions.length > 0 && (
                      <div className="suggestion-section">
                        <div className="suggestion-label">Try a valid document:</div>
                        <div className="suggestion-chips">
                          {r.suggestions.map(s => (
                            <button key={s} className="suggestion-chip" onClick={() => setQuery(`Trace full flow for billing document ${s}`)}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Suggestion chips — for LLM_UNAVAILABLE */}
                    {r.reason === 'LLM_UNAVAILABLE' && r.suggestions && r.suggestions.length > 0 && (
                      <div className="suggestion-section">
                        <div className="suggestion-label">Try one of these queries:</div>
                        <div className="suggestion-chips">
                          {r.suggestions.map((s, si) => (
                            <button key={si} className="suggestion-chip" onClick={() => setQuery(s)}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── DEFAULT VIEW: badges + reasoning + context ── */}

                    {/* Full badges row */}
                    {(r.queryType || r.complexity || r.executionPlan) && (
                      <div className="response-badges">
                        {r.queryType && (
                          <span className={`query-type-badge ${queryTypeBadgeClass(r.queryType)}`}>{r.queryType}</span>
                        )}
                        {r.complexity && (
                          <span className={`query-type-badge ${complexityBadgeClass(r.complexity)}`}>{r.complexity}</span>
                        )}
                        {r.executionPlan && (
                          <span className={`query-type-badge ${planBadgeClass(r.executionPlan)}`}>{r.executionPlan.replace('_', ' ')}</span>
                        )}
                        {r.confidence != null && (
                          <span className={`confidence-badge confidence-badge-${r.confidenceLabel?.toLowerCase() || 'medium'}`}>
                            {Math.round(r.confidence * 100)}% {r.confidenceLabel || ''}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Confidence reasons */}
                    {r.confidenceReasons && r.confidenceReasons.length > 0 && (
                      <div className="confidence-reasons">
                        {r.confidenceReasons.map((reason, ci) => (
                          <span key={ci}>&#8226; {reason}{ci < r.confidenceReasons.length - 1 ? ' ' : ''}</span>
                        ))}
                      </div>
                    )}

                    {/* Query plan reasoning line */}
                    {r.queryPlan && r.queryPlan.reasoning && (
                      <div className="confidence-reasons">
                        <span>&#9654; {r.queryPlan.reasoning}</span>
                      </div>
                    )}

                    {/* Context line */}
                    {r.rowCount > 0 && (
                      <div className="response-context">Based on {r.rowCount} record{r.rowCount !== 1 ? 's' : ''} from your dataset</div>
                    )}
                    {r.queryType === 'RAG' && (
                      <div className="response-context">From knowledge base</div>
                    )}

                    {/* Truncation warning */}
                    {r.truncated && (
                      <div className="chat-info">Showing first 100 results (truncated)</div>
                    )}

                    {/* ── EXPANDABLE DETAILS (progressive disclosure) ── */}
                    {(r.explanation || r.queryPlan || r.metrics || r.sql) && (
                      <details className="response-details">
                        <summary className="details-toggle">View details</summary>

                        {/* How this was answered */}
                        {(r.explanation || r.queryPlan) && (
                          <div className="result-card">
                            <div className="result-card-title">How this was answered</div>
                            {r.explanation && r.explanation.explanationText && (
                              <div className="explanation-summary">{r.explanation.explanationText}</div>
                            )}
                            {r.queryPlan && r.queryPlan.type && (
                              <div className="result-row">
                                <span className="result-label">Analysis Type</span>
                                <span className="result-value">{r.queryPlan.type.replace(/_/g, ' ')}</span>
                              </div>
                            )}
                            {r.queryPlan && r.queryPlan.tablesUsed && r.queryPlan.tablesUsed.length > 0 && (
                              <div className="result-row">
                                <span className="result-label">Data Sources</span>
                                <span className="result-value">{r.queryPlan.tablesUsed.join(' \u2192 ')}</span>
                              </div>
                            )}
                            {r.queryPlan && r.queryPlan.joinPath && r.queryPlan.joinPath.length > 0 && (
                              <div className="result-row">
                                <span className="result-label">Data Flow</span>
                                <span className="result-value">{r.queryPlan.joinPath.map(j => j.label).join(' \u2192 ')}</span>
                              </div>
                            )}
                            {r.explanation && (
                              <div className="result-row">
                                <span className="result-label">Approach</span>
                                <span className="result-value">{r.explanation.strategy}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Execution details */}
                        {r.rowCount > 0 && (
                          <div className="result-card">
                            <div className="result-card-title">Performance</div>
                            <div className="result-row">
                              <span className="result-label">Records</span>
                              <span className="result-value">{r.rowCount}</span>
                            </div>
                            {r.metrics && (
                              <>
                                <div className="result-row">
                                  <span className="result-label">Total Time</span>
                                  <span className="result-value">{(r.metrics.totalTimeMs / 1000).toFixed(2)}s</span>
                                </div>
                                <div className="result-row">
                                  <span className="result-label">Query Time</span>
                                  <span className="result-value">{(r.metrics.sqlTimeMs / 1000).toFixed(2)}s</span>
                                </div>
                                <div className="result-row">
                                  <span className="result-label">Processing Time</span>
                                  <span className="result-value">{(r.metrics.llmTimeMs / 1000).toFixed(2)}s</span>
                                </div>
                              </>
                            )}
                            {r.dataConfidence && (
                              <div className="result-row">
                                <span className="result-label">Data Quality</span>
                                <span className="result-value">{r.dataConfidence.level} — {r.dataConfidence.reason}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Generated SQL */}
                        {(r.sql || r.generatedSql) && (
                          <div className="result-card">
                            <div className="result-card-title">Generated SQL</div>
                            <pre className="sql-block">{r.sql || r.generatedSql}</pre>
                          </div>
                        )}
                      </details>
                    )}
                  </div>
                );
              }
              return null;
            })}

            {/* Loading */}
            {isLoading && (
              <div className="chat-loading">
                <div className="dot-pulse"><span></span><span></span><span></span></div>
                Analyzing query...
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="chat-input-area">
            <div className="chat-status">
              <span className={`status-dot ${isLoading ? 'busy' : ''}`}></span>
              {isLoading ? 'Processing query...' : 'Ready'}
            </div>
            <div className="sql-toggle">
              <label>
                <input type="checkbox" checked={showSql} onChange={e => setShowSql(e.target.checked)} />
                Show generated SQL
              </label>
            </div>
            <form onSubmit={handleSearch} className="chat-input-wrapper">
              <textarea
                placeholder="Ask anything about your data..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                rows={1}
              />
              <button type="submit" className="send-btn" disabled={isLoading || !query.trim()}>
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithBoundary;
