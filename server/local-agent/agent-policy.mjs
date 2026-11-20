import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const DEPLOYMENT_GUIDANCE = 'Deploy or publish only when the user explicitly requests it, using an existing configured target authorized by the user. Inspect the project type and existing deployment configuration first: static HTML or a frontend build may use configured GitHub Pages; a backend or full-stack app needs a configured runtime such as Railway. GitHub Pages cannot run a backend. Build and verify the deployable files before publishing. Use existing authorized CLI authentication without printing secrets, copying credentials into project files, or inventing public URLs. Do not create paid resources or change unrelated account settings. If the target or authentication is unavailable, prepare the deliverable and explain the remaining setup; never claim a deployment succeeded without checking the result.';

const fileTools = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part)); };

async function confinedPath(root, value) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const path = resolve(root, value);
  if (!inside(root, path)) return false;
  let existing = path;
  for (;;) {
    try { return inside(await realpath(root), await realpath(existing)); }
    catch (error) {
      if (error.code !== 'ENOENT') return false;
      const parent = dirname(existing);
      if (parent === existing || !inside(root, parent)) return false;
      existing = parent;
    }
  }
}

// Explicitly enabled for one run only. The Docker sandbox and file path checks remain active.
// Never persist this in project settings or infer it from the model's output.
export function taskApproval(approve, autoApprove = false) {
  return autoApprove === true ? async () => true : approve;
}

// These are project tools. Commands keep the app's existing approval flow.
export async function claudeToolPermission(tool, args, approve, workspace = '/workspace') {
  if (fileTools.has(tool)) {
    const search = tool === 'Glob' || tool === 'Grep';
    const path = search ? args.path ?? workspace : args.file_path;
    if (!await confinedPath(resolve(workspace), path)) return { behavior: 'deny', message: 'Use a path inside the project workspace.' };
    if (tool === 'Glob' && (String(args.pattern || '').split(/[\\/]/).includes('..') || isAbsolute(args.pattern || ''))) {
      return { behavior: 'deny', message: 'Use a glob relative to the project workspace.' };
    }
    return { behavior: 'allow', updatedInput: args };
  }
  if (tool !== 'Bash') return { behavior: 'deny', message: 'This tool is not enabled in Sowalif.' };
  const allowed = await approve(tool, { command: String(args.command || '').slice(0, 12000), description: String(args.description || '') });
  return allowed ? { behavior: 'allow', updatedInput: args } : { behavior: 'deny', message: 'The user declined this command.' };
}
