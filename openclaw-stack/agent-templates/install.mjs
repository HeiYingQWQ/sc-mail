import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templateDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRootInput = process.env.OPENCLAW_WORKSPACE_DIR || '/home/node/.openclaw/workspace';
const targetInput = process.env.SC_MAIL_AGENT_WORKSPACE || workspaceRootInput;
const templateFiles = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'memory/context.md',
  'memory/commitments.md',
];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function requireRegularFile(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected a regular template file: ${path.basename(filePath)}`);
  }
}

async function install() {
  if (!path.isAbsolute(targetInput)) {
    throw new Error('SC_MAIL_AGENT_WORKSPACE must be an absolute path inside the OpenClaw workspace.');
  }

  const workspaceRoot = await realpath(workspaceRootInput);
  const targetWorkspace = await realpath(targetInput);
  const targetInfo = await lstat(targetWorkspace);
  if (!targetInfo.isDirectory() || !isWithin(workspaceRoot, targetWorkspace)) {
    throw new Error('Target must be an existing directory inside OPENCLAW_WORKSPACE_DIR.');
  }

  for (const relativeFile of templateFiles) {
    await requireRegularFile(path.join(templateDirectory, relativeFile));
  }

  const memoryDirectory = path.join(targetWorkspace, 'memory');
  let memoryExists = false;
  try {
    const memoryInfo = await lstat(memoryDirectory);
    if (!memoryInfo.isDirectory() || memoryInfo.isSymbolicLink()) {
      throw new Error('The target memory path exists but is not a regular directory.');
    }
    const resolvedMemoryDirectory = await realpath(memoryDirectory);
    if (!isWithin(targetWorkspace, resolvedMemoryDirectory)) {
      throw new Error('The target memory directory resolves outside the selected workspace.');
    }
    memoryExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (!memoryExists) await mkdir(memoryDirectory);

  const installed = [];
  const preservedExisting = [];
  for (const relativeFile of templateFiles) {
    const source = path.join(templateDirectory, relativeFile);
    const destination = path.join(targetWorkspace, relativeFile);
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      installed.push(relativeFile);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        preservedExisting.push(relativeFile);
        continue;
      }
      throw error;
    }
  }

  process.stdout.write(`${JSON.stringify({ installed, preservedExisting })}\n`);
}

install().catch((error) => {
  process.stderr.write(`Template installation stopped: ${error.message}\n`);
  process.exitCode = 1;
});
