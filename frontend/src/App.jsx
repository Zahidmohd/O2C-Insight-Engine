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

    // Clear existing graph before new query
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    try {
      const response = await axios.post('http://localhost:3000/api/query', { query });
      const { success, requestId, query: reqQuery, rowCount, executionTimeMs, graph } = response.data;
      
      if (success) {
        setResultInfo({
          requestId,
          query: reqQuery,
          rowCount,
          executionTimeMs: Number(executionTimeMs).toFixed(2),
          hasNodes: graph && graph.nodes && graph.nodes.length > 0
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
           <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: '18px', fontWeight: '500', color: '#6a737d' }}>
               No graph data available
           </div>
        )}
      </div>
    </div>
  );
}

export default App;
