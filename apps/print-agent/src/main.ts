/**
 * Entry point.
 *   node --env-file=.env agent.mjs               run the agent
 *   node --env-file=.env agent.mjs --test-print  print one sample ticket (no API needed) and exit
 *   node agent.mjs --setup                       interactive owner sign-in + device token setup
 */
import { renderTicket, SAMPLE_TICKET } from '@sds/escpos';
import { createAgent } from './agent.ts';
import { createPrintApi } from './api.ts';
import { ConfigError, loadConfig, requireApi } from './config.ts';
import { consoleLogger as log } from './log.ts';
import { PrinterError, sendToPrinter } from './printer.ts';
import { runInteractiveSetup } from './setup.ts';
import { openPrintedStore } from './store.ts';

async function main(): Promise<number> {
  if (process.argv.includes('--setup')) {
    return runInteractiveSetup();
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    log('error', 'config.invalid', {
      problem: error instanceof ConfigError ? error.message : 'unknown',
    });
    return 2;
  }

  if (process.argv.includes('--test-print')) {
    try {
      const bytes = renderTicket(
        { ...SAMPLE_TICKET, orderNo: 'TEST', who: 'ทดสอบเครื่องพิมพ์' },
        {
          widthDots: config.printer.widthDots,
        },
      );
      await sendToPrinter(bytes, config.printer);
      log('info', 'testprint.sent');
      return 0;
    } catch (error) {
      log('error', 'testprint.failed', {
        errorCode: error instanceof PrinterError ? error.code : 'OTHER',
      });
      return 1;
    }
  }

  let api: ReturnType<typeof requireApi>;
  try {
    api = requireApi(config);
  } catch (error) {
    log('error', 'config.invalid', {
      problem: error instanceof ConfigError ? error.message : 'unknown',
    });
    return 2;
  }

  const agent = createAgent({
    config,
    api: createPrintApi({ ...api, timeoutMs: config.httpTimeoutMs }),
    store: openPrintedStore(config.printedFile, {
      onProblem: (event) => log('warn', `store.${event}`),
    }),
    log,
    send: sendToPrinter,
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'agent.stopping', { signal });
    agent.stop();
    // Every step has its own timeout, so this only guards against a bug.
    setTimeout(() => {
      log('error', 'agent.stop_forced');
      process.exit(1);
    }, config.stopGraceMs).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)
    process.on(signal, () => stop(signal));

  await agent.run();
  return 0;
}

process.exitCode = await main();
