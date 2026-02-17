import puppeteer, { Page } from 'puppeteer-core'
import { TimeTrackingValues } from './jira'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const waitUntil = async (callback: () => Promise<boolean>) => {
  let res
  while ((res = !(await callback()))) {
    await sleep(200)
  }
  return res
}

// Run
// /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

const getNbRows = async (page: Page) => {
  return (await page.$$('.mainTable tbody > tr'))?.length || 0
}

const createNewRow = async (page: Page) => {
  const nbRowsBefore = await getNbRows(page)
  await page.click('button[data-automation-id="addRow"]')
  await waitUntil(async () => {
    return (await getNbRows(page)) > nbRowsBefore
  })
}

const hasMultipleResults = async (page: Page) => {
  try {
    await page.waitForSelector("xpath///div[contains(text(), 'Résultats de la recherche')]", {
      timeout: 1000,
    })
    return true
  } catch (e) {
    return false
  }
}

const fillSearch = async (page: Page, search: string) => {
  // Click on the first Rechercher input
  const searchWrapper = await page.waitForSelector(
    'xpath///tbody/tr[1]//input[@placeholder="Rechercher"]',
  )
  await searchWrapper?.click()
  await page.waitForSelector("xpath///div[contains(text(), 'Codes de saisie des temps')]")
  const searchInput = await page.waitForSelector('input[data-automation-id="searchBox"]')
  await searchInput?.type(search)
  await page.keyboard.press('Enter')
  // If multiple results, select the first one
  if (await hasMultipleResults(page)) {
    await page.keyboard.press('Enter')
  }
}

const fillRow = async (page: Page, hours: number) => {
  // Select inputs from Monday to Friday
  const firstRowWeekdaysInputs = (await page.$$('input[data-automation-id="numericInput"]')).slice(
    0,
    5,
  )

  for (const input of firstRowWeekdaysInputs) {
    // Click on the input 3 times to select the existing value, then type the new one
    await input.click({ clickCount: 3 })
    await input.type(hours.toString().replace('.', ','))
  }
}

const fillNewRow = async (page: Page, name: string, hours: number) => {
  console.log(`Filling ${name} with ${hours} hours`)
  await createNewRow(page)
  await fillSearch(page, name)
  await fillRow(page, hours)
}

export const fillWorkday = async (timeTrackingValues: TimeTrackingValues, weekStart: Date) => {
  // Format date as DD/MM/YYYY for Workday input
  const formatDateForWorkday = (d: Date) => {
    const day = d.getDate().toString().padStart(2, '0')
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const year = d.getFullYear()
    return `${day}/${month}/${year}`
  }

  const weekDateStr = formatDateForWorkday(weekStart)

  console.log('\n\n---------------------------------')
  console.log(`Filling workday for week starting ${weekDateStr}…`)
  console.log('\n\n---------------------------------')

  // Launch Chrome with a dedicated profile for Workday automation
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--user-data-dir=/tmp/chrome-workday-profile', '--remote-debugging-port=9222'],
  })

  const page = await browser.newPage()

  // Navigate the page to a URL.
  await page.goto(process.env.WORKDAY_TIMETRACKING_URL!)

  // Set screen size.
  await page.setViewport({ width: 1300, height: 700 })

  // Wait until page loads and click "Sélectionner une semaine"
  const selectWeekButton = await page.waitForSelector(
    "xpath///span[contains(text(), 'Sélectionner une semaine')]",
    { timeout: 120000 },
  )
  await selectWeekButton?.click()

  // Wait for date input and fill it with the week start date
  const dateInput = await page.waitForSelector('[data-automation-id="dateInputWrapper"] input')
  await dateInput?.click({ clickCount: 3 })
  await dateInput?.type(weekDateStr)

  // Click OK button to confirm
  const okButton = await page.waitForSelector(
    '[data-automation-id="wd-CommandButton_uic_okButton"]',
  )
  await okButton?.click()

  // Wait for the timesheet page to load
  await page.waitForSelector("xpath///span[contains(text(), 'Saisir les temps par type')]")

  const names = Object.keys(timeTrackingValues)

  for (const name of names) {
    await fillNewRow(page, name, timeTrackingValues[name])
  }

  console.log('\nWorkday filled')
}
