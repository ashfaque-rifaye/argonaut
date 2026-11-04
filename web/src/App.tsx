import { useEffect } from 'react'
import { useStore } from './lib/store'
import { bootstrap } from './lib/socket'
import { Header } from './components/Header'
import { TelemetryStrip } from './components/TelemetryStrip'
import { LiveView } from './components/LiveView'
import { ModelRail } from './components/ModelRail'
import { AgentConsole } from './components/AgentConsole'
import { SpectrumPanel } from './components/SpectrumPanel'
import { WaterfallPanel } from './components/WaterfallPanel'
import { CampbellPanel } from './components/CampbellPanel'
import { ModalPanel } from './components/ModalPanel'
import { InferencePanel } from './components/InferencePanel'
import { TwinPanel } from './components/TwinPanel'
import { ProposalCard } from './components/ProposalCard'
import { EvidenceDrawer } from './components/EvidenceDrawer'
import { Shortcuts } from './components/Shortcuts'
import { SourceDrawer } from './components/SourceDrawer'
import { SampleStrip } from './components/SampleStrip'
import { ActionsPanel } from './components/ActionsPanel'
import { Tour, useFirstVisitTour, WelcomeSheet } from './components/Welcome'
import { cx, TipLayer } from './components/ui'

export function App() {
  const loopTab = useStore((s) => s.optimizerTab === 'loop')
  const idTab = useStore((s) => s.identifyTab)
  const focus = useStore((s) => s.focusView)
  useEffect(() => {
    void bootstrap()
  }, [])
  useFirstVisitTour()

  return (
    <div className="console-bg flex min-h-full flex-col overflow-x-hidden xl:h-screen xl:min-h-[860px] xl:overflow-hidden">
      <Header />
      <div className="px-2 pt-2" data-tour="telemetry">
        <div className="glass overflow-hidden">
          <TelemetryStrip />
        </div>
      </div>
      <main
        className={cx(
          'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2 p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
          focus
            ? 'xl:grid-cols-[minmax(0,58vw)_minmax(0,1fr)_clamp(340px,22vw,420px)]'
            : 'xl:grid-cols-[minmax(520px,37vw)_minmax(0,1fr)_clamp(350px,23vw,430px)]',
        )}
      >
        {/* left · see: the footage first, big */}
        <div className="order-1 flex min-h-0 min-w-0 flex-col gap-2 xl:order-none">
          <div className="flex shrink-0" data-panel="1" data-tour="live">
            <LiveView />
          </div>
          <div className="flex shrink-0" data-tour="machines">
            <SampleStrip />
          </div>
          <div className="flex h-[420px] min-h-[200px] xl:h-auto xl:flex-1" data-tour="agent">
            <AgentConsole />
          </div>
        </div>

        {/* centre · understand */}
        <div className="order-3 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-2 md:col-span-2 xl:order-none xl:col-span-1 xl:grid-rows-[1fr_0.8fr_1.3fr]">
          <div className="flex h-[260px] min-h-0 xl:h-auto" data-panel="2" data-tour="spectrum">
            <SpectrumPanel />
          </div>
          <div className="flex h-[240px] min-h-0 xl:h-auto">
            <WaterfallPanel />
          </div>
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-tour="identify">
            <div className="flex h-[300px] min-h-0 min-w-0 xl:h-auto" data-panel="3">
              <CampbellPanel />
            </div>
            <div className="flex h-[360px] min-h-0 min-w-0 xl:h-auto">
              {idTab === 'faults' ? <InferencePanel /> : idTab === 'twin' ? <TwinPanel /> : <ModalPanel />}
            </div>
          </div>
        </div>

        {/* right · act */}
        <div className="order-2 flex min-h-0 min-w-0 flex-col gap-2 xl:order-none">
          <div className="flex h-[420px] min-h-0 xl:h-auto xl:flex-[1.15]" data-tour="actions">
            <ActionsPanel />
          </div>
          <div data-panel="4 5" data-tour="optimizer" className={cx('flex min-h-[300px] transition-[flex-grow] duration-300 ease-[var(--ease-out-soft)] xl:min-h-0', loopTab ? 'min-h-[560px] xl:flex-[1.9]' : 'xl:flex-[1.25]')}>
            <ProposalCard />
          </div>
          <div className="flex shrink-0">
            <ModelRail compact />
          </div>
        </div>
      </main>
      <EvidenceDrawer />
      <SourceDrawer />
      <Shortcuts />
      <WelcomeSheet />
      <Tour />
      <TipLayer />
    </div>
  )
}
