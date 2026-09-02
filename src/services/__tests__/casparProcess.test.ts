import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processStatus,
  processState,
  isPrimaryInstance,
  isStarting,
  isStopping,
  refreshProcessStatus,
  startCasparServer,
  stopCasparServer,
  restartCasparServer,
  validateCasparExecutablePath,
  type CasparProcessStatus,
  type CasparValidationInfo,
} from '../casparProcess';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe('casparProcess service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processStatus.value = null;
    isStarting.value = false;
    isStopping.value = false;
  });

  it('computes initial state when processStatus is null', () => {
    expect(processState.value).toBe('unconfigured');
    expect(isPrimaryInstance.value).toBe(true);
  });

  it('updates state and role reactively from processStatus', () => {
    processStatus.value = {
      state: 'operational',
      role: 'primary',
      pid: 1234,
      executablePath: 'C:/CasparCG/casparcg.exe',
      resolvedExecutablePath: 'C:/CasparCG/casparcg.exe',
      workingDir: 'C:/CasparCG',
      configFilename: 'casparcg.config',
      exitCode: null,
      lastError: null,
      amcpPort: 5250,
      isPortOpen: true,
      keepAliveOnExit: true,
      canControl: true,
    };

    expect(processState.value).toBe('operational');
    expect(isPrimaryInstance.value).toBe(true);

    processStatus.value = {
      ...processStatus.value,
      state: 'external_running',
      role: 'monitor',
      canControl: false,
    };

    expect(processState.value).toBe('external_running');
    expect(isPrimaryInstance.value).toBe(false);
  });

  it('refreshProcessStatus invokes caspar_process_get_status and updates status', async () => {
    const mockStatus: CasparProcessStatus = {
      state: 'stopped',
      role: 'primary',
      pid: null,
      executablePath: 'C:/CasparCG/casparcg.exe',
      resolvedExecutablePath: 'C:/CasparCG/casparcg.exe',
      workingDir: 'C:/CasparCG',
      configFilename: 'casparcg.config',
      exitCode: null,
      lastError: null,
      amcpPort: 5250,
      isPortOpen: false,
      keepAliveOnExit: true,
      canControl: true,
    };

    (invoke as any).mockResolvedValueOnce(mockStatus);

    const result = await refreshProcessStatus();
    expect(invoke).toHaveBeenCalledWith('caspar_process_get_status');
    expect(result).toEqual(mockStatus);
    expect(processStatus.value).toEqual(mockStatus);
    expect(processState.value).toBe('stopped');
  });

  it('validateCasparExecutablePath invokes caspar_process_validate_path', async () => {
    const mockValidation: CasparValidationInfo = {
      isValid: true,
      resolvedPath: 'C:/CasparCG/casparcg.exe',
      parentDir: 'C:/CasparCG',
      configExists: true,
      configPath: 'C:/CasparCG/casparcg.config',
      message: 'Executable and localized casparcg.config found',
    };

    (invoke as any).mockResolvedValueOnce(mockValidation);

    const res = await validateCasparExecutablePath('C:/CasparCG/casparcg.exe');
    expect(invoke).toHaveBeenCalledWith('caspar_process_validate_path', { path: 'C:/CasparCG/casparcg.exe' });
    expect(res.isValid).toBe(true);
    expect(res.configExists).toBe(true);
  });

  it('startCasparServer invokes caspar_process_start and refreshes status', async () => {
    (invoke as any).mockResolvedValue(undefined);
    await startCasparServer();
    expect(invoke).toHaveBeenCalledWith('caspar_process_start');
    expect(isStarting.value).toBe(false);
  });

  it('stopCasparServer invokes caspar_process_stop and refreshes status', async () => {
    (invoke as any).mockResolvedValue(undefined);
    await stopCasparServer(true);
    expect(invoke).toHaveBeenCalledWith('caspar_process_stop', { force: true });
    expect(isStopping.value).toBe(false);
  });

  it('restartCasparServer invokes caspar_process_restart and refreshes status', async () => {
    (invoke as any).mockResolvedValue(undefined);
    await restartCasparServer();
    expect(invoke).toHaveBeenCalledWith('caspar_process_restart');
    expect(isStarting.value).toBe(false);
  });
});
