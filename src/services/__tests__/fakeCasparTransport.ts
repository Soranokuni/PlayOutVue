/**
 * Deterministic Fake CasparCG Transport for Vitest & Integration Testing.
 * Supports delayed acknowledgements, dropped connections, duplicate EOF signals,
 * reordered tick events, slow LOADBG, and stale 202 PLAY OK responses.
 */

export interface MockAmcpResponse {
  code: number;
  message: string;
  dataLines?: string[];
  delayMs?: number;
  shouldDropConnection?: boolean;
}

export interface FakeOscTick {
  channel: number;
  layer: number;
  path: string;
  timeMs: number;
  durationMs: number;
}

export class FakeCasparTransport {
  private currentTimeMs = 0;
  private responseQueue: Array<{ command: string; response: MockAmcpResponse }> = [];
  private sentCommands: Array<{ command: string; timestampMs: number }> = [];
  private oscListeners: Array<(tick: FakeOscTick) => void> = [];
  private connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'connected';
  private defaultResponseDelayMs = 0;

  // Active channel/layer state simulated on fake Caspar
  public simulatedChannel = 1;
  public simulatedLayer = 10;
  public activeClipPath: string | null = null;
  public activeClipPositionMs = 0;
  public activeClipDurationMs = 0;
  public loadedClipPath: string | null = null;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.currentTimeMs = 0;
    this.responseQueue = [];
    this.sentCommands = [];
    this.oscListeners = [];
    this.connectionStatus = 'connected';
    this.defaultResponseDelayMs = 0;
    this.activeClipPath = null;
    this.activeClipPositionMs = 0;
    this.activeClipDurationMs = 0;
    this.loadedClipPath = null;
  }

  public setConnectionStatus(status: 'connected' | 'disconnected' | 'reconnecting'): void {
    this.connectionStatus = status;
  }

  public getConnectionStatus(): 'connected' | 'disconnected' | 'reconnecting' {
    return this.connectionStatus;
  }

  public setDefaultDelay(delayMs: number): void {
    this.defaultResponseDelayMs = delayMs;
  }

  public queueResponse(commandSubstring: string, response: MockAmcpResponse): void {
    this.responseQueue.push({ command: commandSubstring, response });
  }

  public getSentCommands(): Array<{ command: string; timestampMs: number }> {
    return [...this.sentCommands];
  }

  public getCurrentTimeMs(): number {
    return this.currentTimeMs;
  }

  public advanceTime(ms: number): void {
    this.currentTimeMs += ms;
  }

  public onOscTick(listener: (tick: FakeOscTick) => void): () => void {
    this.oscListeners.push(listener);
    return () => {
      this.oscListeners = this.oscListeners.filter((l) => l !== listener);
    };
  }

  public emitOscTick(tick: FakeOscTick): void {
    if (this.connectionStatus !== 'connected') return;
    for (const listener of this.oscListeners) {
      listener(tick);
    }
  }

  public emitEof(path: string, durationMs: number): void {
    // Emit end-of-file tick where position == duration
    this.emitOscTick({
      channel: this.simulatedChannel,
      layer: this.simulatedLayer,
      path,
      timeMs: durationMs,
      durationMs,
    });
  }

  public async sendAmcpCommand(commandStr: string): Promise<{ code: number; message: string; dataLines: string[] }> {
    if (this.connectionStatus !== 'connected') {
      throw new Error('FakeCasparTransport: AMCP connection dropped');
    }

    const record = { command: commandStr, timestampMs: this.currentTimeMs };
    this.sentCommands.push(record);

    // Look for scripted custom response
    const queueIdx = this.responseQueue.findIndex((item) => commandStr.includes(item.command));
    let response: MockAmcpResponse;

    if (queueIdx >= 0) {
      response = this.responseQueue[queueIdx].response;
      this.responseQueue.splice(queueIdx, 1);
    } else {
      // Default success responses
      response = {
        code: 202,
        message: 'PLAY OK',
        dataLines: [],
        delayMs: this.defaultResponseDelayMs,
      };
    }

    if (response.delayMs && response.delayMs > 0) {
      this.advanceTime(response.delayMs);
    }

    if (response.shouldDropConnection) {
      this.setConnectionStatus('disconnected');
      throw new Error('FakeCasparTransport: AMCP TCP connection dropped during send');
    }

    if (response.code >= 400) {
      throw new Error(`AMCP Error ${response.code}: ${response.message}`);
    }

    // Update internal simulated state based on command verb
    const upper = commandStr.trim().toUpperCase();
    if (upper.startsWith('PLAY ')) {
      this.activeClipPath = commandStr.split(' ')[2] || 'clip';
      this.activeClipPositionMs = 0;
    } else if (upper.startsWith('LOADBG ')) {
      this.loadedClipPath = commandStr.split(' ')[2] || 'clip';
    }

    return {
      code: response.code,
      message: response.message,
      dataLines: response.dataLines || [],
    };
  }
}
