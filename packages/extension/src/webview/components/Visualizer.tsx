import { useEffect, useState, useRef, useMemo, MouseEvent } from 'react';
import { vscode } from '../messages';
import type { FileEdge, FileNode, WorkflowConnection, WorkflowStep, IssueData } from '../messages';
import './Visualizer.css';

interface VisualizerProps {
    issues: IssueData[];
}

export function Visualizer({ issues }: VisualizerProps) {
    const getModuleName = (filePath: string): string => {
        const seg = filePath.split('/');
        if (seg[0]?.startsWith('@')) return `${seg[0]}/${seg[1] || ''}`;
        return seg[0] || 'unknown';
    };
    const isExternalModule = (name: string): boolean => !name.startsWith('@backbrain/');
    interface DirNode { name: string; path: string; type: 'dir' | 'file'; children?: DirNode[]; nodeId?: string; }
    const buildDirTree = (nodes: FileNode[]): DirNode[] => {
        const root: DirNode[] = [];
        for (const node of nodes) {
            const parts = node.fileName.split('/');
            let current = root;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLast = i === parts.length - 1;
                if (isLast) {
                    current.push({ name: part, path: node.fileName, type: 'file', nodeId: node.id });
                } else {
                    let dir = current.find(c => c.type === 'dir' && c.name === part) as DirNode | undefined;
                    if (!dir) {
                        dir = { name: part, path: parts.slice(0, i + 1).join('/'), type: 'dir', children: [] };
                        current.push(dir);
                    }
                    current = dir.children!;
                }
            }
        }
        return root;
    };

    const [graphType, setGraphType] = useState<'files' | 'workflow'>('files');
    const [zoom, setZoom] = useState<number>(1);
    const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
    
    // Local cache for nodes state so they can be dragged
    const [fileNodes, setFileNodes] = useState<FileNode[]>([]);
    const [fileEdges, setFileEdges] = useState<FileEdge[]>([]);
    const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
    const [workflowConnections, setWorkflowConnections] = useState<WorkflowConnection[]>([]);
    
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [filesLayout, setFilesLayout] = useState<'module' | 'tree' | 'graph'>('module');
    const [showExternals, setShowExternals] = useState(true);
    const [expandedBranchIds, setExpandedBranchIds] = useState<Set<string>>(new Set());
    const [treeSearchQuery, setTreeSearchQuery] = useState('');

    const viewportRef = useRef<HTMLDivElement>(null);
    const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const isPanningRef = useRef<boolean>(false);
    
    // Node width/height constants for midpoint calculation
    const NODE_WIDTH = 150;
    const NODE_HEIGHT = 62;
    const NODE_V_SPACING = 90;
    const NODE_H_SPACING = 210;

    interface VisNode {
        id: string;
        label: string;
        subtitle?: string;
        x: number;
        y: number;
        type: 'dir' | 'file' | 'module';
        nodeId?: string;
        lang?: string;
        filePath?: string;
        stats?: { total: number; critical: number; high: number; medium: number; low: number };
        color?: string;
        isExternal?: boolean;
        childrenCount?: number;
    }

    interface VisEdge {
        from: string;
        to: string;
    }

    // Load graph data on mount and active graph type change
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.type === 'graphData') {
                if (message.status === 'ready') {
                    setFileNodes(message.fileGraph.nodes);
                    setFileEdges(message.fileGraph.edges);
                    setWorkflowSteps(message.workflowGraph.steps);
                    setWorkflowConnections(message.workflowGraph.connections);
                    setStatus('ready');
                } else if (message.status === 'loading') {
                    setStatus('loading');
                } else if (message.status === 'error') {
                    setStatus('error');
                    setErrorMsg(message.error || 'Failed to fetch graphs');
                }
            }
        };

        window.addEventListener('message', handleMessage);
        requestGraph();
        
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const requestGraph = () => {
        setStatus('loading');
        vscode.postMessage({ type: 'requestGraphData' });
    };

    // Calculate count of issues per file
    const getFileIssueCount = (filePath: string) => {
        const fileIssues = issues.filter(i => i.filePath === filePath);
        return {
            total: fileIssues.length,
            critical: fileIssues.filter(i => i.severity === 'critical').length,
            high: fileIssues.filter(i => i.severity === 'high').length,
            medium: fileIssues.filter(i => i.severity === 'medium').length,
            low: fileIssues.filter(i => i.severity === 'low').length,
        };
    };

    // Find the currently selected node
    const getSelectedNodeDetails = () => {
        if (!selectedNodeId) return null;
        if (graphType === 'files') {
            const node = fileNodes.find(n => n.id === selectedNodeId);
            if (!node) return null;
            const issueStats = getFileIssueCount(node.filePath);
            const fileIssues = issues.filter(i => i.filePath === node.filePath);
            return {
                type: 'file',
                title: node.fileName,
                filePath: node.filePath,
                language: node.language,
                exports: node.exports,
                imports: node.imports,
                issues: fileIssues,
                issueStats
            };
        } else {
            const step = workflowSteps.find(s => s.id === selectedNodeId);
            if (!step) return null;
            // Check if there are issues related to this step
            const relativeIssues = issues.filter(i => 
                i.description.toLowerCase().includes(step.title.toLowerCase()) || 
                step.description.toLowerCase().includes(i.title.toLowerCase())
            );
            return {
                type: 'step',
                title: step.title,
                description: step.description,
                stepType: step.type,
                issues: relativeIssues
            };
        }
    };

    const handleOpenFile = (filePath: string) => {
        // Find line from issue, or fallback to 1
        const fileIssues = issues.filter(i => i.filePath === filePath);
        const line = fileIssues[0]?.line ?? 1;
        vscode.postMessage({
            type: 'navigateToIssue',
            filePath,
            line,
            column: 1
        });
    };

    // Pan / Zoom handlers
    const handleZoomIn = () => setZoom(z => Math.min(2, z + 0.15));
    const handleZoomOut = () => setZoom(z => Math.max(0.4, z - 0.15));
    const handleZoomReset = () => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    };

    const handleViewportMouseDown = (e: MouseEvent<HTMLDivElement>) => {
        // Only trigger pan if left-clicking background (not on node)
        const target = e.target as HTMLElement;
        if (target.closest('.bb-vis-node') || target.closest('.bb-vis-details-drawer')) {
            return;
        }

        isPanningRef.current = true;
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        panStartRef.current = { ...pan };
        
        // Change grab cursor
        if (viewportRef.current) {
            viewportRef.current.style.cursor = 'grabbing';
        }
    };

    const handleViewportMouseMove = (e: MouseEvent<HTMLDivElement>) => {
        if (isPanningRef.current) {
            const dx = e.clientX - dragStartRef.current.x;
            const dy = e.clientY - dragStartRef.current.y;
            setPan({
                x: panStartRef.current.x + dx,
                y: panStartRef.current.y + dy
            });
            return;
        }

        if (draggedNodeId) {
            // DRAG NODE
            const dx = (e.clientX - dragStartRef.current.x) / zoom;
            const dy = (e.clientY - dragStartRef.current.y) / zoom;

            if (graphType === 'files') {
                setFileNodes(prev => prev.map(n => {
                    if (n.id === draggedNodeId) {
                        const startPos = n.position || { x: 0, y: 0 };
                        return {
                            ...n,
                            position: {
                                x: startPos.x + dx,
                                y: startPos.y + dy
                            }
                        };
                    }
                    return n;
                }));
            } else {
                setWorkflowSteps(prev => prev.map(s => {
                    if (s.id === draggedNodeId) {
                        const startPos = s.position || { x: 0, y: 0 };
                        return {
                            ...s,
                            position: {
                                x: startPos.x + dx,
                                y: startPos.y + dy
                            }
                        };
                    }
                    return s;
                }));
            }

            // Reset start client coordinates for delta tracking
            dragStartRef.current = { x: e.clientX, y: e.clientY };
        }
    };

    const handleViewportMouseUp = () => {
        isPanningRef.current = false;
        setDraggedNodeId(null);
        if (viewportRef.current) {
            viewportRef.current.style.cursor = 'grab';
        }
    };

    const handleNodeMouseDown = (e: MouseEvent<HTMLDivElement>, nodeId: string) => {
        e.stopPropagation();
        setSelectedNodeId(nodeId);
        setDraggedNodeId(nodeId);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
    };

    // Calculate direction-aware bezier edge path exiting from node borders
    const getEdgePath = (sourceId: string, targetId: string): string => {
        let sourceNode: any, targetNode: any;
        if (graphType === 'files') {
            sourceNode = fileNodes.find(n => n.id === sourceId);
            targetNode = fileNodes.find(n => n.id === targetId);
        } else {
            sourceNode = workflowSteps.find(s => s.id === sourceId);
            targetNode = workflowSteps.find(s => s.id === targetId);
        }
        if (!sourceNode || !targetNode) return '';

        const sPos = sourceNode.position || { x: 0, y: 0 };
        const tPos = targetNode.position || { x: 0, y: 0 };

        const sCX = sPos.x + NODE_WIDTH / 2;
        const sCY = sPos.y + NODE_HEIGHT / 2;
        const tCX = tPos.x + NODE_WIDTH / 2;
        const tCY = tPos.y + NODE_HEIGHT / 2;

        const dx = tCX - sCX;
        const dy = tCY - sCY;
        const horizontal = Math.abs(dx) >= Math.abs(dy);

        let sX: number, sY: number, tX: number, tY: number;
        if (horizontal) {
            sX = dx > 0 ? sPos.x + NODE_WIDTH : sPos.x;
            sY = sCY;
            tX = dx > 0 ? tPos.x : tPos.x + NODE_WIDTH;
            tY = tCY;
        } else {
            sX = sCX;
            sY = dy > 0 ? sPos.y + NODE_HEIGHT : sPos.y;
            tX = tCX;
            tY = dy > 0 ? tPos.y : tPos.y + NODE_HEIGHT;
        }

        const bend = horizontal
            ? Math.abs(tX - sX) * 0.45
            : Math.abs(tY - sY) * 0.45;

        const c1x = horizontal ? sX + (dx > 0 ? bend : -bend) : sX;
        const c1y = horizontal ? sY : sY + (dy > 0 ? bend : -bend);
        const c2x = horizontal ? tX - (dx > 0 ? bend : -bend) : tX;
        const c2y = horizontal ? tY : tY - (dy > 0 ? bend : -bend);

        return `M ${sX} ${sY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tX} ${tY}`;
    };

    const selectedDetails = getSelectedNodeDetails();
    const connectedEdgeIds = useMemo(() => {
        if (!selectedNodeId) return new Set<string>();
        return new Set(
            fileEdges
                .filter(e => e.source === selectedNodeId || e.target === selectedNodeId)
                .map(e => e.id)
        );
    }, [selectedNodeId, fileEdges]);

    const moduleGroups = useMemo(() => {
        const map = new Map<string, { name: string; nodes: FileNode[]; issues: IssueData[]; isExternal: boolean }>();
        for (const node of fileNodes) {
            const name = getModuleName(node.filePath);
            if (!map.has(name)) {
                map.set(name, { name, nodes: [], issues: [], isExternal: isExternalModule(name) });
            }
            map.get(name)!.nodes.push(node);
        }
        for (const [, group] of map) {
            const filePaths = new Set(group.nodes.map(n => n.filePath));
            group.issues = issues.filter(i => filePaths.has(i.filePath));
        }
        const groups = Array.from(map.values());
        groups.sort((a, b) => {
            if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1;
            return a.name.localeCompare(b.name);
        });
        return groups;
    }, [fileNodes, issues]);

    const moduleDependencies = useMemo(() => {
        const nodeModuleMap = new Map<string, string>();
        for (const node of fileNodes) {
            nodeModuleMap.set(node.id, getModuleName(node.filePath));
        }
        const deps: Record<string, Set<string>> = {};
        for (const edge of fileEdges) {
            const srcMod = nodeModuleMap.get(edge.source);
            const tgtMod = nodeModuleMap.get(edge.target);
            if (srcMod && tgtMod && srcMod !== tgtMod) {
                if (!deps[srcMod]) deps[srcMod] = new Set();
                deps[srcMod].add(tgtMod);
            }
        }
        return deps;
    }, [fileNodes, fileEdges]);

    const modulePalette = useMemo(() => ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1', '#aed581', '#ffd54f', '#ff8a65', '#ce93d8', '#4db6ac', '#dce775', '#f06292', '#90a4ae', '#7986cb'], []);

    const moduleColorMap = useMemo(() => {
        const map: Record<string, string> = {};
        let i = 0;
        for (const group of moduleGroups) {
            if (!map[group.name]) {
                map[group.name] = modulePalette[i % modulePalette.length];
                i++;
            }
        }
        return map;
    }, [moduleGroups, modulePalette]);

    const dirTree = useMemo(() => buildDirTree(fileNodes), [fileNodes]);

    const filteredFileNodes = useMemo(() => {
        if (!treeSearchQuery) return null;
        const q = treeSearchQuery.toLowerCase();
        return fileNodes.filter(n => n.fileName.toLowerCase().includes(q));
    }, [fileNodes, treeSearchQuery]);

    const hasAutoExpanded = useRef(false);
    useEffect(() => {
        if (status === 'ready' && !hasAutoExpanded.current) {
            const autoExpand = new Set<string>();
            for (const node of fileNodes) {
                const parts = node.fileName.split('/');
                for (let i = 1; i <= parts.length; i++) {
                    const prefix = parts.slice(0, i).join('/');
                    if (prefix.startsWith('@backbrain')) {
                        autoExpand.add(prefix);
                    }
                }
            }
            setExpandedBranchIds(autoExpand);
            hasAutoExpanded.current = true;
        }
    }, [status, fileNodes]);

    const filteredModuleGroups = useMemo(() => {
        if (showExternals) return moduleGroups;
        return moduleGroups.filter(g => !g.isExternal);
    }, [moduleGroups, showExternals]);

    const toggleBranch = (id: string) => {
        setExpandedBranchIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const countDirIssues = (node: DirNode): { total: number; critical: number; high: number; medium: number } => {
        let total = 0, critical = 0, high = 0, medium = 0;
        const walk = (n: DirNode) => {
            if (n.type === 'file' && n.nodeId) {
                const fn = fileNodes.find(f => f.id === n.nodeId);
                if (fn) {
                    const s = getFileIssueCount(fn.filePath);
                    total += s.total; critical += s.critical; high += s.high; medium += s.medium;
                }
            }
            if (n.children) n.children.forEach(walk);
        };
        walk(node);
        return { total, critical, high, medium };
    };

    const computeTreeLayout = (): { nodes: VisNode[]; edges: VisEdge[] } => {
        const nodes: VisNode[] = [];
        const edges: VisEdge[] = [];
        let yCounter = 0;
        const walk = (dirNodes: DirNode[], depth: number, parentId?: string) => {
            for (const dn of dirNodes) {
                const x = 30 + depth * NODE_H_SPACING;
                const y = 20 + yCounter * NODE_V_SPACING;
                yCounter++;
                if (dn.type === 'dir') {
                    const id = `dir:${dn.path}`;
                    const childIssues = countDirIssues(dn);
                    nodes.push({ id, label: dn.name, subtitle: dn.path, x, y, type: 'dir', stats: childIssues, childrenCount: dn.children?.length });
                    if (parentId) edges.push({ from: parentId, to: id });
                    if (expandedBranchIds.has(dn.path) && dn.children && dn.children.length > 0) {
                        walk(dn.children, depth + 1, id);
                    }
                } else {
                    const fileNode = fileNodes.find(f => f.id === dn.nodeId);
                    if (fileNode) {
                        const stats = getFileIssueCount(fileNode.filePath);
                        nodes.push({ id: dn.nodeId!, label: dn.name, subtitle: fileNode.filePath, x, y, type: 'file', nodeId: dn.nodeId!, lang: fileNode.language, filePath: fileNode.filePath, stats });
                        if (parentId) edges.push({ from: parentId, to: dn.nodeId! });
                    }
                }
            }
        };
        walk(dirTree, 0);
        return { nodes, edges };
    };

    const computeModuleLayout = (): { nodes: VisNode[]; edges: VisEdge[] } => {
        const nodes: VisNode[] = [];
        const edges: VisEdge[] = [];
        const modRowY = 20;
        const fileRowY = modRowY + NODE_V_SPACING;
        let x = 30;
        for (const group of filteredModuleGroups) {
            const color = moduleColorMap[group.name] || '#888';
            const severityTotals = { critical: 0, high: 0, medium: 0 };
            for (const iss of group.issues) {
                if (iss.severity === 'critical') severityTotals.critical++;
                else if (iss.severity === 'high') severityTotals.high++;
                else if (iss.severity === 'medium') severityTotals.medium++;
            }
            const modId = `mod:${group.name}`;
            nodes.push({ id: modId, label: group.name, subtitle: `${group.nodes.length} file${group.nodes.length !== 1 ? 's' : ''}`, x, y: modRowY, type: 'module', color, stats: severityTotals, isExternal: group.isExternal, childrenCount: group.nodes.length });
            if (expandedBranchIds.has(group.name) && group.nodes.length > 0) {
                let fx = x - (Math.min(group.nodes.length, 5) * NODE_H_SPACING) / 2;
                for (const node of group.nodes.slice(0, 5)) {
                    const stats = getFileIssueCount(node.filePath);
                    nodes.push({ id: node.id, label: node.fileName.split('/').pop() || node.fileName, subtitle: node.filePath, x: fx, y: fileRowY, type: 'file', nodeId: node.id, lang: node.language, filePath: node.filePath, stats });
                    edges.push({ from: modId, to: node.id });
                    fx += NODE_H_SPACING;
                }
                if (group.nodes.length > 5) {
                    nodes.push({ id: `${modId}:overflow`, label: `+${group.nodes.length - 5} more`, subtitle: '', x: fx, y: fileRowY, type: 'file' });
                    edges.push({ from: modId, to: `${modId}:overflow` });
                }
            }
            x += NODE_H_SPACING;
        }
        return { nodes, edges };
    };

    const visualLayoutData = useMemo((): { nodes: VisNode[]; edges: VisEdge[] } => {
        if (graphType !== 'files') return { nodes: [], edges: [] };
        return filesLayout === 'tree' ? computeTreeLayout() : computeModuleLayout();
    }, [filesLayout, dirTree, filteredModuleGroups, expandedBranchIds, moduleColorMap, fileNodes, issues]);

    const layoutNodePosMap = useMemo(() => {
        const map = new Map<string, { x: number; y: number }>();
        for (const n of visualLayoutData.nodes) {
            map.set(n.id, { x: n.x, y: n.y });
        }
        return map;
    }, [visualLayoutData]);

    const getEdgePathFromPos = (from: { x: number; y: number }, to: { x: number; y: number }): string => {
        const sCX = from.x + NODE_WIDTH / 2;
        const sCY = from.y + NODE_HEIGHT / 2;
        const tCX = to.x + NODE_WIDTH / 2;
        const tCY = to.y + NODE_HEIGHT / 2;
        const dx = tCX - sCX;
        const dy = tCY - sCY;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        let sX: number, sY: number, tX: number, tY: number;
        if (horizontal) {
            sX = dx > 0 ? from.x + NODE_WIDTH : from.x;
            sY = sCY;
            tX = dx > 0 ? to.x : to.x + NODE_WIDTH;
            tY = tCY;
        } else {
            sX = sCX;
            sY = dy > 0 ? from.y + NODE_HEIGHT : from.y;
            tX = tCX;
            tY = dy > 0 ? to.y : to.y + NODE_HEIGHT;
        }
        const bend = horizontal ? Math.abs(tX - sX) * 0.45 : Math.abs(tY - sY) * 0.45;
        const c1x = horizontal ? sX + (dx > 0 ? bend : -bend) : sX;
        const c1y = horizontal ? sY : sY + (dy > 0 ? bend : -bend);
        const c2x = horizontal ? tX - (dx > 0 ? bend : -bend) : tX;
        const c2y = horizontal ? tY : tY - (dy > 0 ? bend : -bend);
        return `M ${sX} ${sY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tX} ${tY}`;
    };

    const renderLayoutEdges = () => visualLayoutData.edges.map((edge, i) => {
        const from = layoutNodePosMap.get(edge.from);
        const to = layoutNodePosMap.get(edge.to);
        if (!from || !to) return null;
        return (
            <path
                key={`${edge.from}→${edge.to}${i}`}
                d={getEdgePathFromPos(from, to)}
                className="bb-vis-edge-line"
                markerEnd="url(#arrowhead)"
            />
        );
    });

    const renderLayoutNodes = () => visualLayoutData.nodes.map(vn => {
        if (vn.type === 'dir' || vn.type === 'module') {
            const canExpand = (vn.childrenCount ?? 0) > 0;
            const isExpanded = expandedBranchIds.has(vn.nodeId ?? vn.id.replace(/^(dir|mod):/, ''));
            return (
                <div
                    key={vn.id}
                    className="bb-vis-node bb-vis-node--dir"
                    style={{
                        left: `${vn.x}px`,
                        top: `${vn.y}px`,
                        pointerEvents: 'auto',
                        width: `${NODE_WIDTH}px`,
                        height: `${NODE_HEIGHT}px`,
                        borderColor: vn.type === 'module' ? (vn.color || undefined) : undefined,
                    }}
                    onClick={() => {
                        const id = vn.type === 'dir' ? vn.subtitle || vn.label : vn.label;
                        if (canExpand) toggleBranch(id);
                    }}
                >
                    <div className="bb-vis-node-header">
                        <span className="bb-vis-node-title" title={vn.label}>
                            {vn.type === 'module' && <span className="bb-vis-node-lang-dot" style={{ background: vn.color || '#888', marginRight: 4 }} />}
                            {vn.label}
                        </span>
                        {canExpand && <span style={{ fontSize: 10, color: 'var(--bb-color-muted)' }}>{isExpanded ? '–' : '+'}</span>}
                    </div>
                    {vn.subtitle && <div className="bb-vis-node-subtitle">{vn.subtitle}</div>}
                    {vn.stats && (vn.stats.critical > 0 || vn.stats.high > 0 || vn.stats.medium > 0) && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                            {vn.stats.critical > 0 && <span className="bb-vis-node-badge bb-vis-node-badge--critical">{vn.stats.critical}</span>}
                            {vn.stats.high > 0 && <span className="bb-vis-node-badge bb-vis-node-badge--high">{vn.stats.high}</span>}
                            {vn.stats.medium > 0 && <span className="bb-vis-node-badge bb-vis-node-badge--medium">{vn.stats.medium}</span>}
                        </div>
                    )}
                    {vn.isExternal && <span style={{ fontSize: 8, color: 'var(--bb-color-muted)' }}>ext</span>}
                </div>
            );
        }
        const stats = vn.stats || { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
        const issueClass = stats.critical > 0 ? ' bb-vis-node--issue-critical' : stats.high > 0 ? ' bb-vis-node--issue-high' : stats.medium > 0 ? ' bb-vis-node--issue-medium' : '';
        return (
            <div
                key={vn.id}
                className={`bb-vis-node${selectedNodeId === vn.nodeId ? ' bb-vis-node--selected' : ''}${issueClass}`}
                style={{
                    left: `${vn.x}px`,
                    top: `${vn.y}px`,
                    pointerEvents: 'auto',
                    width: `${NODE_WIDTH}px`,
                    height: `${NODE_HEIGHT}px`
                }}
                onMouseDown={(e) => {
                    if (vn.nodeId) {
                        e.stopPropagation();
                        setSelectedNodeId(vn.nodeId);
                    }
                }}
            >
                <div className="bb-vis-node-header">
                    <span className="bb-vis-node-title" title={vn.label}>{vn.label}</span>
                    {stats.total > 0 && (
                        <span className={`bb-vis-node-badge bb-vis-node-badge--${stats.critical > 0 ? 'critical' : 'high'}`}>{stats.total}</span>
                    )}
                </div>
                {vn.subtitle && <div className="bb-vis-node-filepath">{vn.subtitle}</div>}
                {vn.lang && <div className="bb-vis-node-lang">{vn.lang}</div>}
            </div>
        );
    });

    return (
        <div className="bb-visualizer-container">
            <div className="bb-vis-toolbar">
                <div className="bb-vis-btn-group">
                    <button 
                        className={`bb-vis-toggle-btn${graphType === 'files' ? ' bb-vis-toggle-btn--active' : ''}`}
                        onClick={() => {
                            setGraphType('files');
                            setSelectedNodeId(null);
                        }}
                    >
                        File Deps
                    </button>
                    <button 
                        className={`bb-vis-toggle-btn${graphType === 'workflow' ? ' bb-vis-toggle-btn--active' : ''}`}
                        onClick={() => {
                            setGraphType('workflow');
                            setSelectedNodeId(null);
                        }}
                    >
                        Logic Flow
                    </button>
                </div>

                {graphType === 'files' && (
                    <div className="bb-vis-btn-group" style={{ marginLeft: '6px' }}>
                        {(['module', 'tree', 'graph'] as const).map(layout => (
                            <button
                                key={layout}
                                className={`bb-vis-toggle-btn${filesLayout === layout ? ' bb-vis-toggle-btn--active' : ''}`}
                                onClick={() => { setFilesLayout(layout); setSelectedNodeId(null); }}
                            >
                                {layout === 'module' ? 'Module' : layout === 'tree' ? 'Tree' : 'Graph'}
                            </button>
                        ))}
                    </div>
                )}

                {graphType === 'files' && filesLayout === 'module' && (
                    <button
                        className="bb-vis-action-btn"
                        onClick={() => setShowExternals(s => !s)}
                        style={{ marginLeft: '4px' }}
                    >
                        {showExternals ? 'Hide ext' : 'Show ext'}
                    </button>
                )}

                {graphType === 'files' && filesLayout === 'tree' && (
                    <input
                        type="text"
                        placeholder="Search files..."
                        value={treeSearchQuery}
                        onChange={e => setTreeSearchQuery(e.target.value)}
                        style={{
                            marginLeft: '6px',
                            flex: 1, maxWidth: '200px',
                            padding: '2px 6px',
                            fontSize: '11px',
                            background: 'var(--bb-color-panel-strong)',
                            border: '1px solid var(--bb-color-border)',
                            borderRadius: 'var(--bb-radius-sm)',
                            color: 'var(--bb-color-foreground)',
                            outline: 'none',
                        }}
                    />
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
                    <button className="bb-vis-action-btn" onClick={handleZoomIn} title="Zoom In">+</button>
                    <button className="bb-vis-action-btn" onClick={handleZoomOut} title="Zoom Out">-</button>
                    <button className="bb-vis-action-btn" onClick={handleZoomReset} title="Reset view">Reset</button>
                    <button className="bb-vis-action-btn" onClick={requestGraph} title="Reload graph">Reload</button>
                    <button className="bb-vis-action-btn" onClick={() => vscode.postMessage({ type: 'openVisualizerTab' })} title="Open Visualizer in new tab">
                        ⛶
                    </button>
                </div>
            </div>

            {status === 'loading' && (
                <div className="bb-vis-loading-wrap">
                    <span style={{ fontSize: '12px', color: 'var(--bb-color-muted)' }}>Generating interactive code map...</span>
                </div>
            )}

            {status === 'error' && (
                <div className="bb-vis-error-wrap">
                    <span style={{ fontWeight: 500, marginBottom: '6px' }}>Error compiling graph</span>
                    <span style={{ fontSize: '11px', color: 'var(--bb-color-muted)' }}>{errorMsg}</span>
                    <button className="bb-small-button" style={{ marginTop: '12px' }} onClick={requestGraph}>Retry</button>
                </div>
            )}

            {status === 'ready' && (
                <div 
                    className="bb-vis-viewport"
                    ref={viewportRef}
                    onMouseDown={handleViewportMouseDown}
                    onMouseMove={handleViewportMouseMove}
                    onMouseUp={handleViewportMouseUp}
                    onMouseLeave={handleViewportMouseUp}
                >
                    {/* SVG Connections Canvas */}
                    <svg className="bb-vis-svg-canvas">
                        <defs>
                            <marker 
                                id="arrowhead" 
                                markerWidth="10" 
                                markerHeight="6" 
                                refX="8" 
                                refY="3" 
                                orient="auto"
                            >
                                <polygon points="0 0, 8 3, 0 6" fill="var(--bb-color-subtle, #666)" />
                            </marker>
                            <marker 
                                id="arrowhead-active" 
                                markerWidth="10" 
                                markerHeight="6" 
                                refX="8" 
                                refY="3" 
                                orient="auto"
                            >
                                <polygon points="0 0, 8 3, 0 6" fill="var(--bb-color-link)" />
                            </marker>
                        </defs>
                        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                            {graphType === 'files' && filesLayout !== 'graph' ? (
                                renderLayoutEdges()
                            ) : graphType === 'files' ? (
                                fileEdges.map((edge) => (
                                    <path 
                                        key={edge.id}
                                        d={getEdgePath(edge.source, edge.target)}
                                        className={`bb-vis-edge-line${
                                            connectedEdgeIds.has(edge.id) ? ' bb-vis-edge-line--active' :
                                            selectedNodeId ? ' bb-vis-edge-line--dimmed' : ''
                                        }`}
                                        markerEnd={connectedEdgeIds.has(edge.id) ? 'url(#arrowhead-active)' : 'url(#arrowhead)'}
                                    >
                                        {edge.label && <title>{edge.label}</title>}
                                    </path>
                                ))
                            ) : (
                                workflowConnections.map((conn) => {
                                    const isGap = conn.condition === 'Unverified path input' || conn.source.includes('gap') || conn.target.includes('gap');
                                    return (
                                        <path 
                                            key={conn.id}
                                            d={getEdgePath(conn.source, conn.target)}
                                            className={`bb-vis-edge-line bb-vis-edge-line--logical${isGap ? ' bb-vis-edge-line--gap' : ''}`}
                                        >
                                            {(conn.label || conn.condition) && <title>{conn.label || conn.condition}</title>}
                                        </path>
                                    );
                                })
                            )}
                        </g>
                    </svg>

                    {/* Nodes Layer */}
                    <div 
                        style={{
                            position: 'absolute',
                            width: '100%',
                            height: '100%',
                            top: 0,
                            left: 0,
                            pointerEvents: 'none',
                            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                            transformOrigin: 'top left'
                        }}
                    >
                        {graphType === 'files' && filesLayout !== 'graph' ? (
                            renderLayoutNodes()
                        ) : graphType === 'files' ? (
                            fileNodes.map((node) => {
                                const pos = node.position || { x: 50, y: 50 };
                                const issueStats = getFileIssueCount(node.filePath);
                                
                                let issueClass = '';
                                if (issueStats.critical > 0) issueClass = ' bb-vis-node--issue-critical';
                                else if (issueStats.high > 0) issueClass = ' bb-vis-node--issue-high';
                                else if (issueStats.medium > 0) issueClass = ' bb-vis-node--issue-medium';

                                return (
                                    <div 
                                        key={node.id}
                                        className={`bb-vis-node${selectedNodeId === node.id ? ' bb-vis-node--selected' : ''}${issueClass}`}
                                        style={{
                                            left: `${pos.x}px`,
                                            top: `${pos.y}px`,
                                            pointerEvents: 'auto',
                                            width: `${NODE_WIDTH}px`,
                                            height: `${NODE_HEIGHT}px`
                                        }}
                                        onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                                    >
                                        <div className="bb-vis-node-header">
                                            <span className="bb-vis-node-title" title={node.fileName}>{node.fileName.split('/').pop() || node.fileName}</span>
                                            {issueStats.total > 0 && (
                                                <span className={`bb-vis-node-badge bb-vis-node-badge--${issueStats.critical > 0 ? 'critical' : 'high'}`}>
                                                    {issueStats.total}
                                                </span>
                                            )}
                                        </div>
                                        <div className="bb-vis-node-filepath" title={node.filePath}>{node.fileName}</div>
                                        <div className="bb-vis-node-lang">{node.language}</div>
                                    </div>
                                );
                            })
                        ) : (
                            workflowSteps.map((step) => {
                                const pos = step.position || { x: 50, y: 50 };
                                const isGap = step.type === 'decision' && (step.id.includes('gap') || step.title.toLowerCase().includes('gap') || step.title.toLowerCase().includes('hole'));
                                
                                return (
                                    <div 
                                        key={step.id}
                                        className={`bb-vis-node bb-vis-node--${step.type}${selectedNodeId === step.id ? ' bb-vis-node--selected' : ''}${isGap ? ' bb-vis-node--gap' : ''}`}
                                        style={{
                                            left: `${pos.x}px`,
                                            top: `${pos.y}px`,
                                            pointerEvents: 'auto',
                                            width: `${NODE_WIDTH}px`,
                                            height: `${NODE_HEIGHT}px`
                                        }}
                                        onMouseDown={(e) => handleNodeMouseDown(e, step.id)}
                                    >
                                        <div className="bb-vis-node-header">
                                            <span className="bb-vis-node-title" title={step.title}>{step.title}</span>
                                            <span style={{ 
                                                fontSize: '7px', 
                                                color: 'var(--bb-color-muted)', 
                                                textTransform: 'uppercase',
                                                border: '0.5px solid var(--bb-color-border)',
                                                borderRadius: '3px',
                                                padding: '0 3px'
                                            }}>
                                                {step.type}
                                            </span>
                                        </div>
                                        <div className="bb-vis-node-subtitle" title={step.description}>{step.description}</div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}

            {/* Inspect Details Drawer */}
            <div className={`bb-vis-details-drawer${selectedDetails ? ' bb-vis-details-drawer--open' : ''}`}>
                <div className="bb-vis-drawer-hdr">
                    <span className="bb-vis-drawer-title">Inspect Node</span>
                    <button 
                        style={{ background: 'transparent', border: 0, color: 'var(--bb-color-muted)', cursor: 'pointer', fontSize: '13px' }}
                        onClick={() => setSelectedNodeId(null)}
                    >
                        ✕
                    </button>
                </div>

                {selectedDetails ? (
                    <div className="bb-vis-drawer-body">
                        <div className="bb-vis-drawer-section">
                            <span className="bb-vis-drawer-label">Title</span>
                            <span className="bb-vis-drawer-val" style={{ fontWeight: 500 }}>{selectedDetails.title}</span>
                        </div>

                        {selectedDetails.type === 'file' && selectedDetails.filePath && (
                            <>
                                <div className="bb-vis-drawer-section">
                                    <span className="bb-vis-drawer-label">Language</span>
                                    <span className="bb-vis-drawer-val">{selectedDetails.language}</span>
                                </div>
                                <div className="bb-vis-drawer-section">
                                    <span className="bb-vis-drawer-label">Path</span>
                                    <span className="bb-vis-drawer-val bb-vis-drawer-val--mono" style={{ fontSize: '10px' }}>
                                        {selectedDetails.filePath}
                                    </span>
                                </div>

                                {selectedDetails.exports && selectedDetails.exports.length > 0 && (
                                    <div className="bb-vis-drawer-section">
                                        <span className="bb-vis-drawer-label">Exports ({selectedDetails.exports.length})</span>
                                        <div className="bb-vis-drawer-tag-list">
                                            {selectedDetails.exports.slice(0, 8).map((exp: string) => (
                                                <span key={exp} className="bb-vis-drawer-tag">{exp}</span>
                                            ))}
                                {selectedDetails.exports.length > 8 && (
                                    <span style={{ fontSize: '9px', color: 'var(--bb-color-muted)' }}>+{selectedDetails.exports.length - 8} more</span>
                                )}
                            </div>
                        </div>
                    )}

                    {(() => {
                        const importedBy = fileEdges
                            .filter(e => e.source === selectedNodeId)
                            .map(e => fileNodes.find(n => n.id === e.target))
                            .filter(Boolean) as FileNode[];
                        const usedBy = fileEdges
                            .filter(e => e.target === selectedNodeId)
                            .map(e => fileNodes.find(n => n.id === e.source))
                            .filter(Boolean) as FileNode[];
                        return (
                            <>
                                {importedBy.length > 0 && (
                                    <div className="bb-vis-drawer-section">
                                        <span className="bb-vis-drawer-label">Imports ({importedBy.length})</span>
                                        <div className="bb-vis-drawer-tag-list">
                                            {importedBy.slice(0, 6).map(n => (
                                                <span key={n.id} className="bb-vis-drawer-tag">{n.fileName.split('/').pop()}</span>
                                            ))}
                                            {importedBy.length > 6 && (
                                                <span style={{ fontSize: '9px', color: 'var(--bb-color-muted)' }}>+{importedBy.length - 6} more</span>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {usedBy.length > 0 && (
                                    <div className="bb-vis-drawer-section">
                                        <span className="bb-vis-drawer-label">Used By ({usedBy.length})</span>
                                        <div className="bb-vis-drawer-tag-list">
                                            {usedBy.slice(0, 6).map(n => (
                                                <span key={n.id} className="bb-vis-drawer-tag">{n.fileName.split('/').pop()}</span>
                                            ))}
                                            {usedBy.length > 6 && (
                                                <span style={{ fontSize: '9px', color: 'var(--bb-color-muted)' }}>+{usedBy.length - 6} more</span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </>
                        );
                    })()}

                    <button 
                        className="bb-vis-open-file-btn" 
                        onClick={() => handleOpenFile(selectedDetails.filePath!)}
                    >
                        Open Code File
                    </button>
                </>
                        )}

                        {selectedDetails.type === 'step' && (
                            <>
                                <div className="bb-vis-drawer-section">
                                    <span className="bb-vis-drawer-label">Type</span>
                                    <span className="bb-vis-drawer-val" style={{ textTransform: 'capitalize' }}>{selectedDetails.stepType}</span>
                                </div>
                                <div className="bb-vis-drawer-section">
                                    <span className="bb-vis-drawer-label">Description</span>
                                    <span className="bb-vis-drawer-val">{selectedDetails.description}</span>
                                </div>
                            </>
                        )}

                        {/* Security Findings Section */}
                        {selectedDetails.issues && selectedDetails.issues.length > 0 && (
                            <div className="bb-vis-drawer-section" style={{ marginTop: '8px' }}>
                                <span className="bb-vis-drawer-label" style={{ color: 'var(--bb-color-error)' }}>
                                    Active Findings ({selectedDetails.issues.length})
                                </span>
                                <div style={{ maxHeight: '180px', overflowY: 'auto', marginTop: '4px' }}>
                                    {selectedDetails.issues.map((issue: IssueData) => (
                                        <div 
                                            key={issue.id}
                                            className={`bb-vis-issue-card bb-vis-issue-card--${issue.severity}`}
                                        >
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                                <span style={{ fontSize: '9px', fontWeight: 600, textTransform: 'uppercase' }}>
                                                    {issue.severity}
                                                </span>
                                                <span style={{ fontSize: '9px', color: 'var(--bb-color-muted)' }}>
                                                    Line {issue.line}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '10px', fontWeight: 500, color: 'var(--bb-color-foreground)' }}>
                                                {issue.title}
                                            </div>
                                            <div style={{ fontSize: '9px', color: 'var(--bb-color-muted)', marginTop: '2px', lineHeight: 1.3 }}>
                                                {issue.description.slice(0, 60)}{issue.description.length > 60 ? '...' : ''}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="bb-vis-empty-drawer">
                        Click on a node to inspect imports, exports, and active security vulnerabilities.
                    </div>
                )}
            </div>
        </div>
    );
}
