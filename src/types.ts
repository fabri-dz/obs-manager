export type ConnectionState = 'offline' | 'connecting' | 'ready' | 'live' | 'error'

export interface StreamerProfile {
  id: string
  name: string
  platform: string
  obsHost: string
  obsPort: number
  hasObsPassword: boolean
  hasStreamKey: boolean
  serviceType: 'rtmp_common' | 'rtmp_custom'
  serviceName: string
  server: string
  initialScene: string
  defaultDurationSeconds: number
  obsExecutable: string
  obsArgs: string
  lightweightInstance: boolean
  autoLaunch: boolean
  closeAfterStop: boolean
  createdAt: string
  updatedAt: string
}

export interface ProfileInput extends Omit<StreamerProfile, 'hasObsPassword' | 'hasStreamKey' | 'createdAt' | 'updatedAt'> {
  obsPassword?: string
  streamKey?: string
  hasObsPassword?: boolean
  hasStreamKey?: boolean
}

export interface RuntimeState {
  profileId: string
  state: ConnectionState
  streaming: boolean
  startedAt: number | null
  endAt: number | null
  currentScene: string
  scenes: string[]
  error: string
  outputDuration: number
  congestion: number
  skippedFrames: number
}

export interface DashboardData {
  profiles: StreamerProfile[]
  runtimes: Record<string, RuntimeState>
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error' | 'disabled'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion: string
  percent: number
  message: string
}

export interface ObsManagerApi {
  getDashboard(): Promise<DashboardData>
  saveProfile(input: ProfileInput): Promise<StreamerProfile>
  deleteProfile(id: string): Promise<void>
  connect(id: string): Promise<RuntimeState>
  start(id: string, durationSeconds: number): Promise<RuntimeState>
  stop(id: string): Promise<RuntimeState>
  setScene(id: string, sceneName: string): Promise<RuntimeState>
  chooseObsExecutable(): Promise<string | null>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdate(callback: (data: DashboardData) => void): () => void
  onUpdaterUpdate(callback: (data: UpdateState) => void): () => void
}

declare global {
  interface Window {
    obsManager: ObsManagerApi
  }
}
