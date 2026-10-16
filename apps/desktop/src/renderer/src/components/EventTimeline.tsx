import { useEffect, useState } from 'react';
import type { AgentEvent } from '../../../../../../packages/shared';
import { Button } from './ui/button';
import './history.css';
const rowHeight = 76;
export function EventTimeline({ events }: { events: AgentEvent[] }) {
  const [scroll, setScroll] = useState(0), [cursor, setCursor] = useState<number | null>(null), [playing, setPlaying] = useState(false), [selected, setSelected] = useState<string>();
  useEffect(() => { if (!playing) return; const timer = setInterval(() => setCursor(c => { const next = Math.min((c ?? 0) + 1, events.length); if (next === events.length) setPlaying(false); return next; }), 400); return () => clearInterval(timer); }, [playing, events.length]);
  const count = Math.min(cursor ?? events.length, events.length), start = Math.min(Math.max(0, Math.floor(scroll / rowHeight) - 2), Math.max(0, count - 5));
  const detail = events.find(e => e.eventId === selected);
  return <div className="event-timeline"><div className="timeline-controls"><Button size="sm" variant="outline" disabled={!events.length} onClick={() => { setCursor(0); setPlaying(true); }}>从头回放</Button><Button size="sm" variant="outline" disabled={!playing} onClick={() => setPlaying(false)}>暂停回放</Button><Button size="sm" variant="outline" onClick={() => { setCursor(null); setPlaying(false); }}>显示全部</Button></div><label>回放进度 {count} / {events.length}<input aria-label="事件回放进度" type="range" min={0} max={events.length} value={count} onChange={e => { setCursor(Number(e.target.value)); setPlaying(false); }} /></label>
    <div className="virtual-events" aria-label="事件时间线" tabIndex={0} onScroll={e => setScroll(e.currentTarget.scrollTop)}><div style={{ height: count * rowHeight, position: 'relative' }}>{events.slice(start, Math.min(count, start + 9)).map((e, i) => <button key={e.eventId} className="virtual-event" style={{ position: 'absolute', top: (start + i) * rowHeight, height: rowHeight }} onClick={() => setSelected(e.eventId)}><span>{e.sequence} · {new Date(e.timestamp).toLocaleTimeString('zh-CN')} · {e.type}</span><p>{e.payload.text?.slice(0, 300) || '无文本事件'}</p></button>)}</div></div>
    {detail && <details className="event-detail" open><summary>事件 {detail.sequence} 完整详情</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details>}
  </div>;
}
