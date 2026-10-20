import type { thReports } from '../th/reports.ts';

/** English catalog: back-office reports and their exports. `satisfies` makes a missing or extra key a type error. */
export const enReports = {
  'report.export.date': 'Business date',
  'report.export.orders': 'Orders',
  'report.export.revenue': 'Revenue (THB)',
  'report.export.avgTicket': 'Average per order (THB)',
  'report.export.commission': 'Platform commission (THB)',
  'report.export.total': 'Total',
  'report.export.itemName': 'Item',
  'report.export.itemUnits': 'Units sold',
  'report.export.itemRevenue': 'Revenue (THB)',
  'report.export.itemShare': 'Share of units (%)',
  'dash.loading': 'Loading the report…',
  'dash.error': 'Could not load the report. Check the internet and try again.',
  'dash.empty': 'No sales in this period yet',
  'dash.excluded':
    '{count} orders are left out of these figures because their refunds exceed what was paid. Please check them.',
  'dash.live': 'Real figures from orders that are paid and confirmed, after refunds',
  'dash.vs.today': 'vs yesterday {value}',
  'dash.vs.week': 'vs last week {value}',
  'dash.vs.month': 'vs last month {value}',
  'dash.vs.year': 'vs last year {value}',
  'dash.vs.none': 'No earlier period to compare with',
  'dash.delta.up': 'Up {value}',
  'dash.delta.down': 'Down {value}',
  'dash.delta.flat': 'No change',
  'dash.channels.summary': 'Share of sales channels: {parts}',
  'dash.channels.part': '{name} {percent}%',
  'dash.table.show': 'Show as a table',
  'dash.table.channel': 'Channel',
  'dash.table.amount': 'Sales',
  'dash.table.share': 'Share',
  'dash.items.bottom': 'Slowest sellers',
  'dash.items.none': 'No items sold in this period yet',
  'dash.items.unit': '{count} sold',
  'dash.heat.title': 'When customers order',
  'dash.heat.hint': 'Orders by business day and the hour they were placed',
  'dash.heat.cell': '{day} {hour}:00 · {count} orders',
  'dash.heat.less': 'Fewer',
  'dash.heat.more': 'More',
  'dash.heat.alt':
    'Table of orders by weekday and hour. The busiest slot is {day} at {hour}:00 with {count} orders',
  'dash.customers.title': 'Customers',
  'dash.customers.ownerOnly': 'Owner only',
  'dash.customers.new': 'New',
  'dash.customers.regular': 'Regular',
  'dash.customers.lapsed': 'Lapsed',
  'dash.customers.rule': 'Lapsed = no order for over 30 days · Regular = 2 or more orders',
  'dash.customers.col.name': 'Customer',
  'dash.customers.col.segment': 'Group',
  'dash.customers.col.orders': 'Orders',
  'dash.customers.col.spent': 'Total spent',
  'dash.customers.col.favourites': 'Favourites',
  'dash.customers.noName': 'LINE customer (no name)',
  'dash.customers.none': 'No customers yet',
  'dash.pending.none': 'No unpaid orders',
  'dash.pending.unpaidDetail': '{amount} · {status}',
  'dash.export.revenue': 'Sales (CSV)',
  'dash.export.items': 'Items (CSV)',
  'dash.export.done': 'Saved {name}',
  'dash.export.failed': 'The export did not work. Try again.',
  'tax.disclaimer':
    'This is an estimate for planning, not a tax return or tax advice. Status: proposed, not yet confirmed with the Revenue Department. Rules of tax year {year}.',
  'tax.status.proposed': 'Proposed - confirm with the Revenue Department',
  'tax.note.pnlIncomplete':
    'The profit and loss is not complete (an order has no cost, or a commission rate is not set). Expenses may be too low, so the estimated tax may be too high.',
  'tax.note.foodCostTwice':
    'Food cost may be counted twice: there is a cost per dish from the menu and an "ingredients" expense. Check the same purchase is not in both.',
  'tax.note.costOfGoodsEstimated':
    'Cost of goods comes from the costs the owner estimated in the menu, not from receipts.',
  'tax.note.expensesNeedRecords':
    'Deducting actual expenses needs records (receipts, vouchers), and the expenses must be necessary and reasonable.',
  'tax.note.allowancesUnchecked':
    'Allowances you entered are not checked against caps or eligibility. Check them with the Revenue Department.',
  'tax.note.halfYearAllowancesHalved':
    'On ภ.ง.ด.94 only half of the allowances can be used. Every item is halved here, but some (home loan interest, life insurance) are counted by what was actually paid Jan-Jun, which is not checked.',
  'tax.note.halfPercentThresholdSources':
    'The 0.5% method: Revenue Department pages disagree on the threshold (60,000 and 120,000 baht). The current form instruction (120,000 baht) is used. The result is the same either way, because the method only matters when income is over 1,000,000 baht.',
  'tax.note.halfPercentNotApplied':
    'The 0.5% method might apply, but the Revenue Department threshold is unclear, so it is not used in the tax shown.',
  'tax.note.yearNotFinished':
    'The tax year is not over. The figures run only to the date in the result.',
  'tax.note.halfYearCredit':
    'Tax paid with ภ.ง.ด.94 is credited in the ภ.ง.ด.90 calculation. This is not worked out here.',
  'tax.note.filingLate':
    'The filing window has passed. If the return is not filed, 1.5% a month of the tax is added, plus a fine of up to 2,000 baht. Ask the Revenue Department.',
} as const satisfies Record<keyof typeof thReports, string>;
