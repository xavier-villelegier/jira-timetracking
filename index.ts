import 'dotenv/config'
import { Command, Option } from 'commander'
import { input, select, confirm } from '@inquirer/prompts'
import { fillWorkday } from './browser'
import { getJiraTimeTrackingValues, TimeTrackingOptions } from './jira'

if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
  console.error(
    'Missing required environment variables: JIRA_EMAIL and/or JIRA_API_TOKEN.\n\n' +
      'To fix this, create a .env file at the project root with:\n\n' +
      '  JIRA_EMAIL=your-email@company.com\n' +
      '  JIRA_API_TOKEN=your-api-token\n\n' +
      'You can generate an API token at:\n' +
      '  https://id.atlassian.com/manage-profile/security/api-tokens',
  )
  process.exit(1)
}

// Get the Monday of a given week (weeks ago from current week)
function getWeekRange(weeksAgo: number): { start: Date; end: Date } {
  const now = new Date()
  const currentDay = now.getDay()
  const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay

  const monday = new Date(now)
  monday.setDate(now.getDate() + diffToMonday - weeksAgo * 7)
  monday.setHours(0, 0, 0, 0)

  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)
  friday.setHours(23, 59, 59, 999)

  return { start: monday, end: friday }
}

function formatWeekLabel(weeksAgo: number): string {
  const { start, end } = getWeekRange(weeksAgo)
  const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (weeksAgo === 0) {
    return `This week (${formatDate(start)} - ${formatDate(end)})`
  } else if (weeksAgo === 1) {
    return `Last week (${formatDate(start)} - ${formatDate(end)})`
  } else {
    return `${weeksAgo} weeks ago (${formatDate(start)} - ${formatDate(end)})`
  }
}

function parseRatio(value: string): number {
  const num = parseFloat(value)
  if (isNaN(num) || num < 0 || num > 1) {
    throw new Error('Ratio must be a number between 0 and 1')
  }
  return num
}

function parseWeek(value: string): number {
  const num = parseInt(value, 10)
  if (isNaN(num) || num < 0 || num > 6) {
    throw new Error('Week must be a number between 0 (this week) and 6')
  }
  return num
}

interface ProgramOptions {
  maintenanceRatio?: number
  adminRatio?: number
  week?: number
  yes?: boolean
}

const program = new Command()

program
  .name('timetracking')
  .description('Fill Workday timesheet based on Jira activity')
  .version('1.0.0')
  .addOption(
    new Option('-m, --maintenance-ratio <ratio>', 'Maintenance ratio (0-1)')
      .argParser(parseRatio)
      .default(undefined),
  )
  .addOption(
    new Option('-a, --admin-ratio <ratio>', 'Administration ratio (0-1)')
      .argParser(parseRatio)
      .default(undefined),
  )
  .addOption(
    new Option('-w, --week <number>', 'Week to fill (0=this week, 1=last week, ..., 6=6 weeks ago)')
      .argParser(parseWeek)
      .default(undefined),
  )
  .addOption(
    new Option('-y, --yes', 'Skip confirmation prompt (auto-confirm submission)').default(false),
  )
  .action(async (opts: ProgramOptions) => {
    console.log('\n🕐 Jira → Workday Time Tracking\n')

    // Maintenance ratio: use CLI option or prompt
    let maintenanceRatio: number
    if (opts.maintenanceRatio !== undefined) {
      maintenanceRatio = opts.maintenanceRatio
    } else {
      const maintenanceInput = await input({
        message: 'Maintenance ratio (0-1):',
        default: '0.2',
        validate: value => {
          const num = parseFloat(value)
          if (isNaN(num) || num < 0 || num > 1) {
            return 'Please enter a number between 0 and 1'
          }
          return true
        },
      })
      maintenanceRatio = parseFloat(maintenanceInput)
    }

    // Admin ratio: use CLI option or prompt
    let adminRatio: number
    if (opts.adminRatio !== undefined) {
      adminRatio = opts.adminRatio
      if (adminRatio + maintenanceRatio > 1) {
        console.error(
          `Error: Total ratios cannot exceed 1 (maintenance: ${maintenanceRatio}, admin: ${adminRatio})`,
        )
        process.exit(1)
      }
    } else {
      const adminInput = await input({
        message: 'Administration ratio (0-1):',
        default: '0.2',
        validate: value => {
          const num = parseFloat(value)
          if (isNaN(num) || num < 0 || num > 1) {
            return 'Please enter a number between 0 and 1'
          }
          if (num + maintenanceRatio > 1) {
            return `Total ratios cannot exceed 1 (maintenance: ${maintenanceRatio})`
          }
          return true
        },
      })
      adminRatio = parseFloat(adminInput)
    }

    // Week selection: use CLI option or prompt
    let weeksAgo: number
    if (opts.week !== undefined) {
      weeksAgo = opts.week
      console.log(`Selected week: ${formatWeekLabel(weeksAgo)}`)
    } else {
      const weekChoices = Array.from({ length: 7 }, (_, i) => ({
        name: formatWeekLabel(i),
        value: i,
      }))

      weeksAgo = await select({
        message: 'Select the week to fill:',
        choices: weekChoices,
      })
    }

    const { start: weekStart, end: weekEnd } = getWeekRange(weeksAgo)

    console.log('\n')

    // Get Jira time tracking values
    const options: TimeTrackingOptions = {
      maintenanceRatio,
      adminRatio,
      weekStart,
      weekEnd,
    }

    const timeTrackingValues = await getJiraTimeTrackingValues(options)

    // Fill Workday
    await fillWorkday(timeTrackingValues, weekStart)

    // Confirmation: skip if --yes flag is set
    console.log('\n')
    if (opts.yes) {
      console.log('✅ Timesheet filled (auto-confirmed with --yes)')
    } else {
      const submitted = await confirm({
        message: 'Did you submit the timesheet in Workday?',
        default: false,
      })

      if (submitted) {
        console.log('\n✅ Timesheet submitted successfully!')
      } else {
        console.log('\n⚠️  Remember to submit your timesheet in Workday manually.')
      }
    }

    process.exit(0)
  })

program.parse()
