import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import cytoscape from 'cytoscape';
import './App.css';

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

function App() {
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
  const [uploadStatus, setUploadStatus] = useState(null); // null | 'loading' | { success, message }

  const cyRef = useRef(null);
  const cyContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const isDraggingTooltip = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const fileInputRef = useRef(null);
  const abortControllerRef = useRef(null);

  const API_BASE = import.meta.env.VITE_API_URL || '';

  const [datasetError, setDatasetError] = useState(false);

  const fetchDatasetInfo = () => {
    setDatasetError(false);
    fetch(`${API_BASE}/api/dataset`)
      .then(r => r.json())
      .then(data => setDatasetInfo(data))
      .catch(() => setDatasetError(true));
  };

  // Fetch active dataset metadata on mount
  useEffect(() => {
    fetchDatasetInfo();
  }, []);

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
        // Default node: small dot, no label
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
        // Selected / tapped node: show label
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
        // Edges: very thin, light blue
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
        // Edge labels hidden class
        {
          selector: 'edge.hide-label',
          style: { 'label': '' }
        },
        // Node type colors — red/pink outlined dots for documents, blue for others
        {
          selector: 'node[type="SalesOrder"]',
          style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' }
        },
        {
          selector: 'node[type="Delivery"]',
          style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' }
        },
        {
          selector: 'node[type="BillingDocument"]',
          style: { 'background-color': '#e87c8a', 'border-color': '#e87c8a' }
        },
        {
          selector: 'node[type="JournalEntry"]',
          style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' }
        },
        {
          selector: 'node[type="Payment"]',
          style: { 'background-color': '#6b9cf7', 'border-color': '#6b9cf7' }
        },
        {
          selector: 'node[type="Customer"]',
          style: { 'background-color': '#e87c8a', 'border-color': '#e87c8a' }
        },
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

    // Tap node: select it (shows label), open tooltip
    cyRef.current.on('tap', 'node', (evt) => {
      // Deselect all, then select tapped
      cyRef.current.nodes().deselect();
      evt.target.select();

      // Clamp tooltip position within graph panel bounds
      const container = cyContainerRef.current;
      const pos = evt.renderedPosition;
      const tooltipW = 320;
      const tooltipH = 350;
      const cw = container ? container.offsetWidth : 800;
      const ch = container ? container.offsetHeight : 600;

      let x = pos.x + 20;
      let y = pos.y + 20;

      // If tooltip goes off right edge, flip to left side of node
      if (x + tooltipW > cw) x = pos.x - tooltipW - 10;
      // If tooltip goes off bottom, move it up
      if (y + tooltipH > ch) y = Math.max(10, ch - tooltipH - 10);
      // If still off top, clamp
      if (y < 10) y = 10;

      setSelectedNode({
        data: evt.target.data()
      });
      setTooltipPos({ x, y });
    });

    // Tap background: deselect and close tooltip
    cyRef.current.on('tap', (evt) => {
      if (evt.target === cyRef.current) {
        cyRef.current.nodes().deselect();
        setSelectedNode(null);
      }
    });

    // Apply current label visibility state
    if (!showLabels && cyRef.current) {
      cyRef.current.edges().addClass('hide-label');
    }

    // Highlight specific queried nodes
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

    // Cancel any in-flight request before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await axios.post(`${API_BASE}/api/query`, { query: currentQuery, includeSql: showSql }, { timeout: 30000, signal: controller.signal });
      const { success, requestId, dataset, queryType, query: reqQuery, rowCount, executionTimeMs, graph, reason, suggestions, summary, highlightNodes: hl, nlAnswer, sql, explanation, confidence, confidenceLabel, confidenceReasons, queryPlan, truncated, message } = response.data;

      if (success) {
        const info = {
          requestId,
          dataset: dataset || null,
          queryType: queryType || null,
          query: reqQuery,
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
          queryPlan: queryPlan || null,
          truncated: truncated || false,
          message: message || null
        };
        setResultInfo(info);

        // Add to chat history
        setChatHistory(prev => [...prev, { type: 'user', text: currentQuery }, { type: 'agent', info }]);

        initCytoscape(graph, hl || []);
      }
    } catch (err) {
      // Silently ignore cancelled requests (user fired a new query)
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

  return (
    <div className="app-container">
      {/* TOP NAV */}
      <div className="top-nav">
        <div className="nav-icon">&#9649;</div>
        <div className="nav-breadcrumb">
          Mapping <span className="nav-separator">/</span> <span className="nav-active">{dsName}</span>
        </div>
        {datasetInfo && (
          <div className="nav-dataset-badge">
            {datasetInfo.tableCount} tables
          </div>
        )}
        {datasetError && (
          <button className="nav-dataset-badge" style={{ cursor: 'pointer', color: '#b91c1c' }} onClick={fetchDatasetInfo}>
            Retry Connection
          </button>
        )}
        <button className="nav-upload-btn" onClick={() => { setUploadStatus(null); setShowUploadModal(true); }}>
          Switch Dataset
        </button>
      </div>

      {/* Dataset Upload Modal */}
      {showUploadModal && (
        <div className="modal-overlay" onClick={() => setShowUploadModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Switch Dataset</h3>
              <button className="modal-close" onClick={() => setShowUploadModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
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
              {uploadStatus && uploadStatus !== 'loading' && (
                <div className={`upload-status ${uploadStatus.success ? 'upload-success' : 'upload-error'}`}>
                  {uploadStatus.message}
                </div>
              )}
              {uploadStatus === 'loading' && (
                <div className="upload-status upload-loading">
                  <div className="dot-pulse"><span></span><span></span><span></span></div>
                  Initializing dataset...
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

          {/* Floating overlay buttons */}
          <div className="graph-overlay-buttons">
            <button className="overlay-btn" onClick={handleFitGraph} disabled={!cyRef.current}>
              <span className="btn-icon">&#8596;</span> Fit View
            </button>
            <button className="overlay-btn" onClick={handleToggleLabels}>
              <span className="btn-icon">&#9783;</span> {showLabels ? 'Hide Edge Labels' : 'Show Edge Labels'}
            </button>
          </div>

          {/* Empty graph state */}
          {(!resultInfo || (resultInfo && !resultInfo.hasNodes)) && !isLoading && (
            <div className="graph-empty-state">
              <div className="empty-icon">&#9672;</div>
              {!resultInfo && <div>Ask a question to visualize the graph</div>}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'INVALID_ID' && (
                <div style={{ color: '#b91c1c' }}>Document not found in the dataset</div>
              )}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'NO_FLOW' && (
                <div style={{ color: '#92400e' }}>No connected flow found</div>
              )}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'AGGREGATION' && (
                <div style={{ color: '#4a6cf7' }}>Aggregation results shown in chat</div>
              )}
              {resultInfo && !resultInfo.hasNodes && resultInfo.reason === 'RAG_RESPONSE' && (
                <div style={{ color: '#4a6cf7' }}>Knowledge base answer shown in chat</div>
              )}
              {resultInfo && !resultInfo.hasNodes && !resultInfo.reason && (
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
            // Count edges connected to this node
            const connections = cyRef.current ? cyRef.current.getElementById(selectedNode.data.id).connectedEdges().length : 0;

            return (
              <div
                className="node-tooltip"
                style={{
                  left: tooltipPos.x + 'px',
                  top: tooltipPos.y + 'px'
                }}
                onMouseDown={handleTooltipDragStart}
              >
                <h4>{selectedNode.data.type || 'Entity'}</h4>
                <div className="tooltip-body">
                  <div className="tooltip-line"><span className="tooltip-key">Entity:</span> {selectedNode.data.type}</div>
                  {visible.map(([key, val]) => (
                    <div key={key} className="tooltip-line">
                      <span className="tooltip-key">{key}:</span> {val?.toString() || ''}
                    </div>
                  ))}
                  {hiddenCount > 0 && (
                    <div className="tooltip-hidden">Additional fields hidden for readability</div>
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
              Hi! I can help you analyze the <strong>{dsName}</strong> process. Try asking things like:
              <ul style={{ marginTop: 8, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, fontSize: '12.5px', color: '#6b6b80' }}>
                <li>Trace full flow for billing document 90504204</li>
                <li>Top 5 customers by billing amount</li>
                <li>Show all cancelled billing documents</li>
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
                  <div key={i}>
                    {r.nlAnswer && (
                      <div className="chat-agent-msg">
                        <div className="chat-agent-header">
                          <div className="agent-avatar-sm">{dsShort}</div>
                          <span className="agent-name-sm">Graph Agent</span>
                        </div>
                        <div className="chat-agent-bubble">{r.nlAnswer}</div>
                      </div>
                    )}
                    {!r.nlAnswer && r.summary && (
                      <div className={r.reason === 'INVALID_ID' ? 'chat-error' : r.reason === 'NO_FLOW' ? 'chat-info' : 'chat-welcome'}>
                        {r.summary}
                      </div>
                    )}
                    {/* Zero-data message — shown when no nlAnswer and backend provides a reason message */}
                    {r.message && !r.nlAnswer && (
                      <div className="chat-info">{r.message}</div>
                    )}
                    {r.reason === 'INVALID_ID' && r.suggestions && r.suggestions.length > 0 && (
                      <div>
                        <div style={{ fontSize: '12px', color: '#6b6b80', marginBottom: 6 }}>Try a valid document:</div>
                        <div className="suggestion-chips">
                          {r.suggestions.map(s => (
                            <button key={s} className="suggestion-chip" onClick={() => setQuery(`Trace full flow for billing document ${s}`)}>
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Confidence score */}
                    {r.confidence != null && (
                      <div className="confidence-text">
                        <div>Confidence: {Math.round(r.confidence * 100)}%{r.confidenceLabel && ` (${r.confidenceLabel})`}</div>
                        {r.confidenceReasons && r.confidenceReasons.length > 0 && (
                          <div className="confidence-reasons">
                            {r.confidenceReasons.map((reason, i) => (
                              <span key={i}>&#8226; {reason}{i < r.confidenceReasons.length - 1 ? ' ' : ''}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Query execution plan */}
                    {r.queryPlan && (
                      <div className="confidence-text">Plan: {r.queryPlan}</div>
                    )}
                    {/* Truncation warning */}
                    {r.truncated && (
                      <div className="chat-info">Showing first 1000 results (truncated)</div>
                    )}
                    {/* Explanation — how the query was answered */}
                    {r.explanation && (
                      <div className="result-card">
                        <div className="result-card-title">How this was answered</div>
                        {r.explanation.explanationText && (
                          <div className="explanation-summary">{r.explanation.explanationText}</div>
                        )}
                        <div className="result-row">
                          <span className="result-label">Intent</span>
                          <span className="result-value">{r.explanation.intent}</span>
                        </div>
                        {r.explanation.entities && r.explanation.entities.length > 0 && (
                          <div className="result-row">
                            <span className="result-label">Entities</span>
                            <span className="result-value">
                              {r.explanation.entities.map(e => e.replace(/_/g, ' ')).join(', ')}
                            </span>
                          </div>
                        )}
                        <div className="result-row">
                          <span className="result-label">Strategy</span>
                          <span className="result-value">{r.explanation.strategy}</span>
                        </div>
                      </div>
                    )}
                    {/* Generated SQL — only when includeSql was true */}
                    {(r.sql || r.generatedSql) && (
                      <div className="result-card">
                        <div className="result-card-title">Generated SQL (Debug View)</div>
                        <pre className="sql-block">{r.sql || r.generatedSql}</pre>
                      </div>
                    )}
                    {r.rowCount > 0 && (
                      <div className="result-card">
                        <div className="result-card-title">Execution Details</div>
                        {r.dataset && (
                          <div className="result-row">
                            <span className="result-label">Dataset</span>
                            <span className="result-value">{r.dataset}</span>
                          </div>
                        )}
                        {r.queryType && (
                          <div className="result-row">
                            <span className="result-label">Query Type</span>
                            <span className="result-value">
                              <span className={`query-type-badge badge-${r.queryType.toLowerCase()}`}>{r.queryType}</span>
                            </span>
                          </div>
                        )}
                        <div className="result-row">
                          <span className="result-label">Query</span>
                          <span className="result-value">{r.query}</span>
                        </div>
                        <div className="result-row">
                          <span className="result-label">Request ID</span>
                          <span className="result-value">{r.requestId}</span>
                        </div>
                        <div className="result-row">
                          <span className="result-label">Rows</span>
                          <span className="result-value">{r.rowCount}</span>
                        </div>
                        <div className="result-row">
                          <span className="result-label">Execution</span>
                          <span className="result-value">{r.executionTimeMs} ms</span>
                        </div>
                      </div>
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

          {/* Input Area (Bottom) */}
          <div className="chat-input-area">
            <div className="chat-status">
              <span className={`status-dot ${isLoading ? 'busy' : ''}`}></span>
              {isLoading ? 'Processing query...' : 'Graph Agent is awaiting instructions'}
            </div>
            <div className="sql-toggle">
              <label>
                <input type="checkbox" checked={showSql} onChange={e => setShowSql(e.target.checked)} />
                Show SQL (for developers)
              </label>
            </div>
            <form onSubmit={handleSearch} className="chat-input-wrapper">
              <textarea
                placeholder="Analyze anything"
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
