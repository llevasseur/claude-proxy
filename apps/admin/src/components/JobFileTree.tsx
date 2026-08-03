import { useMemo, useState } from 'react';
import type { JobFileKind, JobTreeNode } from '@claude-proxy/core';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
} from 'lucide-react';
import { fmtBytes } from '../format';

/** Icon per file kind — the tree's only visual cue about what a row opens into. */
const KIND_ICONS: Record<JobFileKind, typeof File> = {
  json: FileJson,
  jsonl: FileJson,
  markdown: FileText,
  log: FileText,
  code: FileCode,
  text: FileText,
  image: ImageIcon,
  binary: File,
};

export interface JobFileTreeProps {
  nodes: JobTreeNode[];
  /** Path of the file currently open in the viewer, or null. */
  selected: string | null;
  onSelect: (node: JobTreeNode) => void;
}

/** A node plus whether the tree is currently showing it. */
interface VisibleRow {
  node: JobTreeNode;
  expanded: boolean;
}

/** Flatten the tree to the rows currently visible, honouring collapsed directories. */
function visibleRows(nodes: readonly JobTreeNode[], collapsed: ReadonlySet<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (list: readonly JobTreeNode[]): void => {
    for (const node of list) {
      const expanded = node.dir && !collapsed.has(node.path);
      rows.push({ node, expanded });
      if (expanded) walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}

/**
 * The job directory as a browsable folder tree. Directories toggle open; files
 * select into the viewer beside it. Rows are flattened rather than nested so the
 * whole tree is one scroller with one tab order.
 */
export function JobFileTree({ nodes, selected, onSelect }: JobFileTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => visibleRows(nodes, collapsed), [nodes, collapsed]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  if (nodes.length === 0) return <div className='empty'>This job directory is empty.</div>;

  return (
    <div className='jobtree' role='tree' aria-label='Job files'>
      {rows.map(({ node, expanded }) => {
        const Icon = node.dir ? (expanded ? FolderOpen : Folder) : KIND_ICONS[node.kind ?? 'binary'];
        const active = !node.dir && node.path === selected;
        return (
          <button
            key={node.path}
            type='button'
            role='treeitem'
            aria-expanded={node.dir ? expanded : undefined}
            aria-selected={active}
            className={`jobtree-row${active ? ' active' : ''}${node.dir ? ' is-dir' : ''}`}
            style={{ paddingLeft: 8 + node.depth * 14 }}
            onClick={() => (node.dir ? toggle(node.path) : onSelect(node))}>
            <span className='jobtree-caret' aria-hidden>
              {node.dir && !node.skipped ? (
                expanded ? (
                  <ChevronDown size={13} strokeWidth={2} />
                ) : (
                  <ChevronRight size={13} strokeWidth={2} />
                )
              ) : null}
            </span>
            <Icon className='jobtree-icon' size={14} strokeWidth={1.75} aria-hidden />
            <span className='jobtree-name'>{node.name}</span>
            {node.link && <span className='jobtree-tag'>link</span>}
            {node.skipped && <span className='jobtree-tag'>not walked</span>}
            <span className='jobtree-meta'>
              {node.dir
                ? node.skipped
                  ? ''
                  : `${node.files} file${node.files === 1 ? '' : 's'}`
                : fmtBytes(node.bytes)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
