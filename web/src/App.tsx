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
import { TwinPanel } from './components/TwinPanel'
import { ProposalCard } from './components/ProposalCard'
import { EvidenceDrawer } from './components/EvidenceDrawer'

export function App() {
  const loopTab = useStore((s) => s.optimizerTab === 'loop')
  useEffect(() => {
    void bootstrap()
  }, [])

  return (
    <div className="flex min-h-full flex-col overflow-x-hidden bg-bg-0 xl:h-screen xl:min-h-[820px] xl:overflow-hidden">
      <Header />
      <div className="border-b border-line-1">
        <TelemetryStrip />
      </div>
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-px bg-bg-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[clamp(360px,24vw,450px)_minmax(0,1fr)_clamp(360px,23vw,430px)]">
        {/* left: sense + models + agent */}
        <div className="order-1 flex min-h-0 min-w-0 flex-col gap-px xl:order-none">
          <div className="flex shrink-0">
            <LiveView />
          </div>
          <div className="flex shrink-0">
            <ModelRail />
          </div>
          <div className="flex h-[440px] min-h-[200px] xl:h-auto xl:flex-1">
            <AgentConsole />
          </div>
        </div>

        {/* center: identify */}
        <div className="order-3 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-px md:col-span-2 xl:order-none xl:col-span-1 xl:grid-rows-[1fr_0.92fr_1.28fr]">
          <div className="flex h-[260px] min-h-0 xl:h-auto">
            <SpectrumPanel />
          </div>
          <div className="flex h-[240px] min-h-0 xl:h-auto">
            <WaterfallPanel />
          </div>
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-px md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex h-[300px] min-h-0 min-w-0 xl:h-auto">
              <CampbellPanel />
            </div>
            <div className="flex h-[340px] min-h-0 min-w-0 xl:h-auto">
              <ModalPanel />
            </div>
          </div>
        </div>

        {/* right: twin + optimize */}
        <div className="order-2 flex min-h-0 min-w-0 flex-col gap-px xl:order-none">
          <div className={`flex min-h-[300px] xl:min-h-0 ${loopTab ? 'min-h-[560px] xl:flex-[2.6]' : 'xl:flex-[1.55]'}`}>
            <ProposalCard />
          </div>
          <div className="flex h-[340px] min-h-0 xl:h-auto xl:flex-1">
            <TwinPanel />
          </div>
        </div>
      </main>
      <EvidenceDrawer />
    </div>
  )
}
