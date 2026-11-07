// 一点内联样式 + 三个小控件。不引 CSS 文件，避免和宿主的类名打架。
const ui = {
  section: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary, inherit)' },
  heading: { margin: 0, fontSize: '18px', fontWeight: 600 },
  intro: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #888)' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px 14px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
    borderRadius: '10px',
  },
  row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  label: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #888)' },
  value: { fontSize: '13px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' },
  button: {
    font: 'inherit',
    fontSize: '13px',
    lineHeight: '20px',
    padding: '5px 12px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  primary: { background: 'var(--dsw-alias-state-business-primary, #4c6ef5)', borderColor: 'transparent', color: '#fff' },
  input: {
    font: 'inherit',
    fontSize: '13px',
    padding: '5px 8px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
    background: 'transparent',
    color: 'inherit',
    minWidth: '120px',
  },
  dot: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' },
  bar: { width: '100%', height: '6px', borderRadius: '3px', background: 'rgba(127,127,127,.25)', overflow: 'hidden' },
  barFill: { height: '100%', background: 'var(--dsw-alias-state-business-primary, #4c6ef5)' },
}

function Btn(props) {
  const { primary, disabled, onClick, children, title } = props
  return react.createElement(
    'button',
    {
      type: 'button',
      title,
      disabled,
      onClick,
      style: { ...ui.button, ...(primary ? ui.primary : {}), ...(disabled ? { opacity: 0.5, cursor: 'default' } : {}) },
    },
    children,
  )
}

function Toggle(props) {
  const { checked, onChange, label, title } = props
  return react.createElement(
    'label',
    { style: { ...ui.row, gap: '8px', cursor: 'pointer', fontSize: '13px' }, title },
    react.createElement('input', { type: 'checkbox', checked: !!checked, onChange: (event) => onChange(event.target.checked) }),
    react.createElement('span', null, label),
  )
}

function Progress(props) {
  const { value, total } = props
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0
  return react.createElement(
    'div',
    { style: ui.bar },
    react.createElement('div', { style: { ...ui.barFill, width: `${(ratio * 100).toFixed(1)}%` } }),
  )
}

function StateDot(props) {
  const color = props.state === 'ready' ? '#2f9e44' : props.state === 'error' ? '#e03131' : props.state === 'installing' ? '#f08c00' : '#868e96'
  return react.createElement('span', { style: { ...ui.dot, background: color }, title: props.title })
}
