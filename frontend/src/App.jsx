import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import cytoscape from 'cytoscape';
import './App.css';

function App() {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Results
  const [resultInfo, setResultInfo] = useState(null);
  
  // Tooltip
  const [selectedNode, setSelectedNode] = useState(null);

  // Cytoscape ref
  const cyRef = useRef(null);
  const cyContainerRef = useRef(null);

  // Unmount logic for Cytoscape
  useEffect(() => {
    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
      }
    };
  }, []);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setError(null);
    setResultInfo(null);
    setSelectedNode(null);

    // Clear existing graph before new query
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    try {
      const response = await axios.post('http://localhost:3000/api/query', { query });
      const { success, requestId, query: reqQuery, rowCount, executionTimeMs, graph, reason, suggestions, summary } = response.data;
      
      if (success) {
        setResultInfo({
          requestId,
          query: reqQuery,
          rowCount,
          executionTimeMs: Number(executionTimeMs).toFixed(2),
          hasNodes: graph && graph.nodes && graph.nodes.length > 0,
          reason,
          suggestions,
          summary
        });

        // Initialize Cytoscape
        const elements = [
          ...graph.nodes.map(n => ({ data: n })),
          ...graph.edges.map(e => ({ data: e }))
        ];

        cyRef.current = cytoscape({
          container: cyContainerRef.current,
          elements: elements,
          style: [
            {
              selector: 'node',
              style: {
                'content': 'data(label)',
                'text-wrap': 'wrap',
                'text-valign': 'center',
                'text-halign': 'center',
                'background-color': '#0052cc',
                'color': '#fff',
                'font-size': '10px',
                'width': '60px',
                'height': '60px',
                'border-width': 2,
                'border-color': '#fff',
                'shape': 'ellipse'
              }
            },
            {
              selector: 'edge',
              style: {
                'width': 2,
                'line-color': '#9dbaea',
                'target-arrow-color': '#9dbaea',
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                'label': 'data(type)',
                'font-size': '10px',
                'text-rotation': 'autorotate',
                'text-background-opacity': 1,
                'text-background-color': '#ffffff',
                'text-background-padding': 2,
                'color': '#333'
              }
            },
            {
              selector: 'node[type="SalesOrder"]',
              style: { 'background-color': '#2e7d32' } // Green
            },
            {
              selector: 'node[type="Delivery"]',
              style: { 'background-color': '#f57c00' } // Orange
            },
            {
              selector: 'node[type="BillingDocument"]',
              style: { 'background-color': '#ed3b3b' } // Red
            },
            {
              selector: 'node[type="JournalEntry"]',
              style: { 'background-color': '#1976d2' } // Blue
            },
            {
              selector: 'node[type="Payment"]',
              style: { 'background-color': '#8e24aa' } // Purple
            },
            {
              selector: 'node[type="Customer"]',
              style: { 'background-color': '#424242' } // Dark Gray
            },
            {
              selector: 'node[type="Plant"], node[type="Product"]',
              style: { 'background-color': '#ffb300', 'color': '#000' } // Yellow
            }
          ],
          layout: {
            name: 'cose',
            padding: 50,
            animate: true
          }
        });

        // Initialize click handlers bridging the newly exposed properties
        cyRef.current.on('tap', 'node', (evt) => {
          const node = evt.target;
          setSelectedNode({
            data: node.data(),
            position: evt.renderedPosition
          });
        });

        cyRef.current.on('tap', (evt) => {
          if (evt.target === cyRef.current) {
            setSelectedNode(null);
          }
        });

      }
    } catch (err) {
      console.error(err);
      
      let errMsg = 'An error occurred connecting to the API.';
      if (err.response?.data?.error) {
         errMsg = typeof err.response.data.error === 'object' 
             ? err.response.data.error.message 
             : err.response.data.error;
      } else if (err.message) {
         errMsg = err.message;
      }

      setError(errMsg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      {/* LEFT PANEL */}
      <div className="left-panel">
        <h2 className="title">SAP O2C Graph Query</h2>
        <form onSubmit={handleSearch} className="search-form">
          <textarea 
            placeholder="E.g., Show me the journal entry linked to billing document 91150187"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={isLoading}
          />
          <button type="submit" disabled={isLoading || !query.trim()}>
            {isLoading ? 'Querying...' : 'Execute Query'}
          </button>
        </form>

        {isLoading && <div className="loading" style={{ color: '#0052cc', fontWeight: 'bold', textAlign: 'center' }}>Loading...</div>}

        {error && (
          <div className="error-box">
            <b>Error: </b> {error}
          </div>
        )}

        {resultInfo ? (
          <div className="result-info">
            <h3>Execution Results</h3>
            <div className="info-item">
              <span className="label">Query:</span>
              <span className="val">{resultInfo.query}</span>
            </div>
            <div className="info-item">
              <span className="label">Request ID:</span>
              <span className="val">{resultInfo.requestId}</span>
            </div>
            <div className="info-item">
              <span className="label">Rows Parsed:</span>
              <span className="val">{resultInfo.rowCount}</span>
            </div>
            <div className="info-item">
              <span className="label">Execution Time:</span>
              <span className="val">{resultInfo.executionTimeMs} ms</span>
            </div>
          </div>
        ) : (
          !isLoading && !error && (
            <div className="empty-state">
              <p>Type a query above to explore the graph.</p>
            </div>
          )
        )}
      </div>

      {/* RIGHT PANEL */}
      <div className="right-panel">
        <div ref={cyContainerRef} className="cy-container" />
        {resultInfo && !resultInfo.hasNodes && (
           <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: '18px', fontWeight: '500', color: '#6a737d', textAlign: 'center', backgroundColor: '#fff', padding: '24px', borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
               {resultInfo.reason === 'INVALID_ID' ? (
                   <>
                       <div style={{ color: '#d32f2f', marginBottom: '8px' }}>Billing document not found...</div>
                       <div style={{ fontSize: '14px', marginBottom: '16px' }}>{resultInfo.summary}</div>
                       {resultInfo.suggestions && resultInfo.suggestions.length > 0 && (
                           <div style={{ fontSize: '14px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
                               <span style={{ display: 'block', marginBottom: '8px' }}>Try one of these valid examples:</span>
                               <ul style={{ listStyle: 'none', padding: 0, display: 'flex', gap: '8px', justifyContent: 'center' }}>
                                   {resultInfo.suggestions.map(s => (
                                       <li key={s}>
                                           <button 
                                             type="button"
                                             onClick={() => setQuery(`Trace full flow for billing document ${s}`)} 
                                             style={{ padding: '6px 10px', fontSize: '13px', cursor: 'pointer', backgroundColor: '#f0f5ff', color: '#0052cc', borderRadius: '4px', border: '1px solid #adc2eb' }}
                                           >
                                             {s}
                                           </button>
                                       </li>
                                   ))}
                               </ul>
                           </div>
                       )}
                   </>
               ) : resultInfo.reason === 'NO_FLOW' ? (
                   <>
                       <div style={{ color: '#f57c00', marginBottom: '8px' }}>No connected flow found...</div>
                       <div style={{ fontSize: '14px' }}>{resultInfo.summary}</div>
                   </>
               ) : (
                   <div>No graph data available</div>
               )}
           </div>
        )}

        {/* Node Hover Tooltip Card */}
        {selectedNode && selectedNode.data.properties && (
          <div className="node-tooltip" style={{
            position: 'absolute',
            left: selectedNode.position.x + 20 + 'px',
            top: selectedNode.position.y + 20 + 'px',
            backgroundColor: '#ffffff',
            boxShadow: '0 8px 30px rgba(0,0,0,0.15)',
            border: '1px solid #e0e0e0',
            borderRadius: '8px',
            padding: '16px',
            width: '320px',
            zIndex: 1000,
            pointerEvents: 'auto'
          }}>
            <h4 style={{ margin: '0 0 12px 0', color: '#333', fontSize: '15px' }}>{selectedNode.data.type || 'Entity Details'}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
              {Object.entries(selectedNode.data.properties).map(([key, val]) => (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', borderBottom: '1px solid #f0f0f0', paddingBottom: '4px' }}>
                  <span style={{ color: '#666', fontSize: '12px' }}>{key}</span>
                  <span style={{ color: '#222', fontSize: '12px', wordBreak: 'break-word', fontWeight: '500' }}>{val?.toString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
