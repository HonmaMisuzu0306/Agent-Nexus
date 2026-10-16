import { useMemo, useState } from 'react';
import { Background, Controls, Position, ReactFlow, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LeaderPlan } from '../../../../../../packages/shared/leader';
import { validateDependencies } from '../../../../../../packages/shared/workflows';

export function WorkflowGraph({ tasks, onChange, selected, onSelect, onError, statuses = {} }: { tasks: LeaderPlan['tasks']; onChange?: (tasks: LeaderPlan['tasks']) => void; selected?: string; onSelect?: (id: string) => void; onError?: (error: string) => void; statuses?: Record<string, string> }) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const nodes = useMemo(() => tasks.map((t, i) => ({ id: t.taskId, position: positions[t.taskId] ?? { x: (i % 3) * 245, y: Math.floor(i / 3) * 155 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: `${t.taskId} · ${t.title}\n${t.assignedAgentId} · ${statuses[t.taskId] ?? (t.needsWriteAccess ? '项目写入' : '只读')}` }, selected: selected === t.taskId, style: { width: 205 }, deletable: false })), [tasks, positions, selected, statuses]);
  const edges = tasks.flatMap(t => t.dependsOn.map(id => ({ id: `${id}:${t.taskId}`, source: id, target: t.taskId, deletable: !!onChange })));
  const changeNodes = (changes: NodeChange[]) => setPositions(old => { const next = { ...old }; for (const c of changes) if (c.type === 'position' && c.position) next[c.id] = c.position; return next; });
  return <div className="workflow-graph" aria-label="工作流图"><ReactFlow nodes={nodes} edges={edges} onNodesChange={changeNodes} onNodeClick={(_, n) => onSelect?.(n.id)} nodesConnectable={!!onChange} edgesReconnectable={false} onConnect={c => {
    if (!onChange || !c.source || !c.target) return;
    const next = tasks.map(t => t.taskId === c.target ? { ...t, dependsOn: [...new Set([...t.dependsOn, c.source])] } : t);
    try { validateDependencies(next); onChange(next); } catch (e) { onError?.((e as Error).message); }
  }} onEdgesDelete={deleted => onChange?.(tasks.map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => !deleted.some(e => e.source === id && e.target === t.taskId)) })))} fitView minZoom={0.3} maxZoom={1.5} colorMode="system" ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大工作流', 'controls.zoomOut.ariaLabel': '缩小工作流', 'controls.fitView.ariaLabel': '适应工作流画布' }}><Background /><Controls showInteractive={false} /></ReactFlow></div>;
}
