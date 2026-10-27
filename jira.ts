import { Version3Client } from 'jira.js'
import countBy from 'lodash-es/countBy'
import mapValues from 'lodash-es/mapValues'
import forEach from 'lodash-es/forEach'

export type TimeTrackingValues = {
  [key: string]: number
}

export type TimeTrackingOptions = {
  maintenanceRatio: number
  adminRatio: number
  weekStart: Date
  weekEnd: Date
}

const NB_HOURS_PER_DAY = 8

const client = new Version3Client({
  host: process.env.JIRA_HOST!,
  authentication: {
    basic: {
      email: process.env.JIRA_EMAIL!,
      apiToken: process.env.JIRA_API_TOKEN!,
    },
  },
})

// Cache for initiative lookups to avoid redundant API calls
const initiativeCache = new Map<string, string | null>()

// Traverse up the parent chain until we find an Initiative
async function findInitiative(issueKey: string): Promise<string | null> {
  if (initiativeCache.has(issueKey)) {
    return initiativeCache.get(issueKey)!
  }

  const issue = await client.issues.getIssue({
    issueIdOrKey: issueKey,
    fields: ['parent', 'issuetype', 'summary'],
  })

  const issueType = issue.fields.issuetype?.name

  // If this issue is an Initiative (or DAA Initiative), return its key
  if (issueType?.includes('Initiative')) {
    initiativeCache.set(issueKey, issueKey)
    return issueKey
  }

  // If there's a parent, traverse up
  if (issue.fields.parent) {
    const parentKey = issue.fields.parent.key
    const initiative = await findInitiative(parentKey)
    initiativeCache.set(issueKey, initiative)
    return initiative
  }

  // No parent and not an Initiative
  initiativeCache.set(issueKey, null)
  return null
}

export const getJiraTimeTrackingValues = async (
  options: TimeTrackingOptions,
): Promise<TimeTrackingValues> => {
  const { maintenanceRatio, adminRatio, weekStart, weekEnd } = options
  const remainingRatio = parseFloat((1 - maintenanceRatio - adminRatio).toFixed(2))

  const formatDate = (d: Date) => d.toISOString().split('T')[0]

  console.log('---------------------------------')
  console.log(`Time tracking for week: ${formatDate(weekStart)} to ${formatDate(weekEnd)}`)
  console.log(`Hours per day: ${NB_HOURS_PER_DAY}`)
  console.log(`Maintenance ratio: ${maintenanceRatio}`)
  console.log(`Administration ratio: ${adminRatio}`)
  console.log(`Remaining feature ratio: ${remainingRatio}`)
  console.log('---------------------------------')

  const roundDown = (value: number) => Math.floor(value * 100) / 100

  const jql = `updated >= "${formatDate(weekStart)}" AND updated <= "${formatDate(weekEnd)}" AND assignee = currentUser() AND type != Epic`

  const { issues } = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
    jql,
    fields: ['parent', 'summary'],
  })

  const issueInitiatives: string[] = []

  if (!issues || issues.length === 0) {
    console.log('No issues found')
  } else {
    // Find the initiative for each issue
    console.log('\nFinding initiatives for each issue...')

    for (const issue of issues) {
      const initiative = await findInitiative(issue.key)
      if (initiative) {
        issueInitiatives.push(initiative)
        console.log(`  ${issue.key} → ${initiative}`)
      } else {
        console.log(`  ${issue.key} → (no initiative found)`)
      }
    }
  }

  const initiativesPonderation = countBy(issueInitiatives)

  const initiativesPercentage = mapValues(initiativesPonderation, value =>
    roundDown(value / issueInitiatives.length),
  )

  const initiativesHours = mapValues(initiativesPercentage, value =>
    roundDown(value * remainingRatio * NB_HOURS_PER_DAY),
  )

  // With no initiative to allocate the feature ratio to, scale maintenance and
  // admin up proportionally so they still cover the full day
  const baseRatio = maintenanceRatio + adminRatio
  const scale = issueInitiatives.length === 0 && baseRatio > 0 ? 1 / baseRatio : 1

  if (scale !== 1) {
    console.log(
      `\nNo initiative found: redistributing the ${remainingRatio} feature ratio proportionally over maintenance and administration`,
    )
  }

  const hoursPerDay: Record<string, number> = {
    maintenance: roundDown(maintenanceRatio * scale * NB_HOURS_PER_DAY),
    admin: roundDown(adminRatio * scale * NB_HOURS_PER_DAY),
    ...initiativesHours,
  }

  const totalHoursBefore = Object.values(hoursPerDay).reduce((a, b) => a + b, 0)
  const leftOver = parseFloat((NB_HOURS_PER_DAY - totalHoursBefore).toFixed(2))

  hoursPerDay.maintenance += leftOver

  console.log('\n')
  console.log('WORKING HOURS PER DAY')
  forEach(hoursPerDay, (value, key) => {
    console.log(`${key}: ${value}h`)
  })

  const totalHoursAfter = Object.values(hoursPerDay).reduce((a, b) => a + b, 0)
  console.log('\n')
  console.log(`Total hours: ${totalHoursAfter}h`)

  return hoursPerDay
}
