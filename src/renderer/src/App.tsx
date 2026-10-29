import { WorkflowProvider } from './state/WorkflowContext'
import GrayShell from './components/GrayShell'

export default function App() {
  return (
    <WorkflowProvider>
      <GrayShell />
    </WorkflowProvider>
  )
}
