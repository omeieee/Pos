import type { thPrint } from '../th/print.ts';

/** English catalog: kitchen printing (P8). `satisfies` makes a missing or extra key a type error. */
export const enPrint = {
  'settings.printing.title': 'Order printing',
  'settings.printing.desc': 'Turn kitchen order printing on or off, and see the latest print jobs',
  'settings.printing.switch': 'Print orders automatically',
  'settings.printing.switchHint': 'Tickets come out of the printer on the print notebook',
  'settings.printing.stateOn': 'It is on now: new orders are sent to print',
  'settings.printing.stateOff': 'It is off now: new orders do not print',
  'settings.printing.explainOff':
    'While the switch is off, new orders print nothing and are skipped. No tickets wait to print later.',
  'settings.printing.explainReprint':
    'An order that was skipped can be printed later with the “Reprint order” button on the order page.',
  'settings.printing.explainShutdown':
    'Turn this switch off before you shut the print notebook down, so no tickets pile up in the queue.',
  'settings.printing.jobs.title': 'Recent print jobs',
  'settings.printing.jobs.hint':
    'Shows whether the print notebook has picked the jobs up. If a job stays “Waiting” for long, check that the notebook is on.',
  'settings.printing.jobs.refresh': 'Refresh',
  'settings.printing.jobs.empty': 'No print jobs yet',
  'settings.printing.jobs.loading': 'Loading print jobs…',
  'settings.printing.jobs.loadFailed': 'Could not load the print jobs',
  'settings.printing.jobs.listLabel': 'Recent print jobs',
  'settings.printing.jobs.kind.kitchen': 'Order ticket',
  'settings.printing.jobs.kind.reprint': 'Reprint no. {seq}',
  'settings.printing.jobs.status.pending': 'Waiting',
  'settings.printing.jobs.status.claimed': 'Printing',
  'settings.printing.jobs.status.printed': 'Printed',
  'settings.printing.jobs.status.failed': 'Failed',
  'settings.printing.jobs.error.PRINTER_OFFLINE': 'The printer did not answer',
  'settings.printing.jobs.error.OUT_OF_PAPER': 'Out of paper',
  'settings.printing.jobs.error.COVER_OPEN': 'The printer cover is open',
  'settings.printing.jobs.error.TIMEOUT': 'The printer took too long',
  'settings.printing.jobs.error.RENDER_FAILED': 'The ticket could not be drawn',
  'settings.printing.jobs.error.LEASE_EXPIRED': 'The print notebook stopped answering',
  'settings.printing.jobs.error.OTHER': 'Another reason',
  'print.reprint.button': 'Reprint order',
  'print.reprint.sending': 'Sending to print…',
  'print.reprint.done':
    'Sent to print (reprint no. {seq}). The ticket will come out in the kitchen.',
  'print.reprint.offline':
    'No internet, so printing cannot be sent. Try again when the signal is back.',
  'error.printingOff':
    'Printing is off in Settings. Ask a manager or the owner to turn on “Order printing”, then try again.',
} as const satisfies Record<keyof typeof thPrint, string>;
