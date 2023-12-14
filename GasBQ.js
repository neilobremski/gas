/**
* Run a query job and retrieve results.
* @param {string} q - SQL statement to run.
* @param {number} timeout - Optional timeout in milliseconds, defaults to `BQ_WAIT_TIMEOUT`.
* @returns {object} QueryResults - https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults#response-body
*/
function doQuery(q, timeout) {
    return getQueryResults(createQueryJob(q).id, timeout)
}

/**
* Create an export job.
* @param {string} jobId - Job ID which may include project and location.
* @returns {object} Job -https://cloud.google.com/bigquery/docs/reference/rest/v2/Job
*/
function createExport(jobId) {
    const job = getJob(jobId)
    const cache = job.configuration.query.destinationTable

    const request = {
        "configuration": {
            "jobType": "extract",
            "extract": {
                "destinationUris": [
                    `gs://${GS_EXPORT_BUCKET}/export/${job.jobReference.jobId}__*.csv`
                ],
                "sourceTable": {
                    "datasetId": cache.datasetId,
                    "projectId": cache.projectId,
                    "tableId": cache.tableId
                }
            }
        }
    }

    return BigQuery.Jobs.insert(request, BQ_PROJECT_ID)
}

/**
* Retrieve HTTPS links to download files for completed export.
* @param {string} jobId - Job ID which may include project and location.
* @returns {array} urls - List of links or `null` if job is still running.
*/
function getDownloadLinks(jobId) {
    const job = getJob(jobId)
    if (job.status.state !== "DONE") {
        return null
    }

    let urls = []  // list of download link URLs to return

    // one export can have multiple destinations AND multiple files
    for (destinationUri of job.configuration.extract.destinationUris) {
        // parse the destination URI into its components: bucket AND path
        // (the URI may contain a wildcard/asterisk; chop there if found)
        const uriParts = destinationUri.match(/^gs:\/\/([^/]+)\/([^*]+)/)
        if (!uriParts) {
            throw Error(`Unrecognized URI: ${destinationUri}`)
        }
        const bucket = uriParts[1]
        const prefix = uriParts[2]

        // if the URI did *not* contain a wildcard/asterisk then the destination URI
        // can be transformed directly into the final URL
        if (destinationUri.indexOf('*') < 0) {
            urls.push(`https://storage.cloud.google.com/${bucket}/${prefix}`)
            continue
        }

        // otherwise enumerate all files in the bucket matching the prefix ...

        // Google Cloud Storage is not a "first class" API in Google Apps Script.
        // Thus the JSON API is called in a raw way via UrlFetchApp.
        // https://github.com/googleworkspace/apps-script-oauth2/tree/master/samples/NoLibrary
        const apiUrl = [
            "https://storage.googleapis.com/storage/v1/b/", encodeURIComponent(bucket),
            "/o?prefix=", encodeURIComponent(prefix)
        ].join('')
        Logger.log(`GAPI: ${apiUrl}`)
        const response = UrlFetchApp.fetch(apiUrl, {
            headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }
        })

        const results = JSON.parse(response.getContentText())
        for (item of (results.items || [])) {
            urls.push(`https://storage.cloud.google.com/${bucket}/${item.name}`)
        }
    }
    return urls
}

/**
* Retrieve information about a job.
* @param {string} jobId - Job ID which may include project and location.
* @returns {object} Job -https://cloud.google.com/bigquery/docs/reference/rest/v2/Job
*/
function getJob(jobId) {
    const jobRef = parseJobRef(jobId)
    if (!jobRef.location) {
        return BigQuery.Jobs.get(jobRef.projectId, jobRef.jobId)
    }
    return BigQuery.Jobs.get(jobRef.projectId, jobRef.jobId, { location: jobRef.location })
}

/**
* Create a query job and return information about it.
* @param {string} sqlStatement - SQL statement to run.
* @returns {object} Job -https://cloud.google.com/bigquery/docs/reference/rest/v2/Job
*/
function createQueryJob(sqlStatement) {
    Logger.log(sqlStatement);

    const request = {
        "configuration": {
            "jobType": "query",
            "query": {
                "query": sqlStatement,
                "defaultDataset": {
                    "datasetId": "datawarehouse",
                    "projectId": BQ_PROJECT_ID
                },
                "allowLargeResults": false,
                "useLegacySql": false,
                "maximumBytesBilled": BQ_MAX_BYTES,
                "priority": "INTERACTIVE"  // "BATCH" is another option
            }
        }
    }

    return BigQuery.Jobs.insert(request, BQ_PROJECT_ID)
}

/**
* Return results of a query. Check `.jobComplete` of return to verify data is available.
* @param {string} jobId - Job ID which may include project and location.
* @param {integer} timeout - Optional timeout defaults to `BQ_WAIT_TIMEOUT`
* @param {integer} maxCells - Optional maximum number of cells to return defaults to `BQ_MAX_CELLS`
* @returns {object} QueryResults - https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults#response-body
*/
function getQueryResults(jobId, timeout, maxCells) {
    maxCells = maxCells || BQ_MAX_CELLS
    timeout = timeout || BQ_WAIT_TIMEOUT
    const jobRef = parseJobRef(jobId)

    // https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults
    Logger.log(`QJOB: ${jobRef.jobId} (${jobRef.projectId} in ${jobRef.location || "unknown location"}); ${timeout}ms timeout`)
    const optionalArgs = {
        location: jobRef.location,
        maxResults: 5,
        timeoutMs: timeout/*,
   formatOptions: {useInt64Timestamp: 1}*/
    }

    const startTime = (new Date()).getTime()
    const queryResults = BigQuery.Jobs.getQueryResults(jobRef.projectId, jobRef.jobId, optionalArgs)
    const elapsed = (new Date()).getTime() - startTime

    Logger.log(`DONE: ${queryResults.jobComplete} after ${elapsed}ms`)
    if (!queryResults.jobComplete) {
        return queryResults
    }

    // get full results (if finished) up to maxCells
    const maxResults = parseInt(maxCells / queryResults.schema.fields.length)
    if (maxResults > optionalArgs.maxResults || queryResults.totalRows >= maxResults) {
        Logger.log(`ROWS: Retrieving ${maxResults} of ${queryResults.totalRows}`)
        optionalArgs.maxResults = maxResults
        return BigQuery.Jobs.getQueryResults(jobRef.projectId, jobRef.jobId, optionalArgs)
    }

    return queryResults
}


/**
* Parse job ID into a JobReference object
* @param {object} jobId - String or Object containing job information.
*/
function parseJobRef(jobId) {
    if (typeof (jobId) !== "string") {
        return jobId  // return as-is if already a job reference object
    }

    let jobRef = {
        projectId: BQ_PROJECT_ID,
        jobId: jobId
    }

    // jobId from Job.jobId is the same as:
    // `${Job.jobReference.projectId}:${Job.jobReference.location}.${Job.jobReference.jobId}`
    let matchFullId = jobId.match(/^([^:]+):([^.]+)\.(.*)$/)
    if (matchFullId) {
        jobRef.projectId = matchFullId[1]
        jobRef.location = matchFullId[2]
        jobRef.jobId = matchFullId[3]
    }

    return jobRef
}

function bigquery(sql, headers) {
    // https://developers.google.com/apps-script/advanced/bigquery
    const request = {
        query: sql,
        useLegacySql: false,
        formatOptions: { useInt64Timestamp: true },
        defaultDataset: {
            datasetId: "datawarehouse",
            projectId: BQ_PROJECT_ID
        }
    };

    Logger.log(sql);
    let queryResults = BigQuery.Jobs.query(request, BQ_PROJECT_ID);
    let jobId = queryResults.jobReference.jobId;

    Logger.log(`BQ Job: ${jobId}`);

    let sleepTimeMs = 500;
    while (!queryResults.jobComplete) {
        Logger.log(`Waiting for query: ${jobId} (${sleepTimeMs})`);
        Utilities.sleep(sleepTimeMs);
        sleepTimeMs *= 2;
        queryResults = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, jobId);
    }

    if (headers) {
        queryResults.schema.fields.map(field => field.name).forEach(fieldName => {
            headers.push(fieldName);
        });
    }

    let rows = queryResults.rows;
    while (queryResults.pageToken) {
        queryResults = BigQuery.Jobs.getQueryResults(BQ_PROJECT_ID, jobId, {
            pageToken: queryResults.pageToken
        });
        rows = rows.concat(queryResults.rows);
    }

    let data = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
        let cols = rows[i].f;
        data[i] = new Array(cols.length);
        for (let j = 0; j < cols.length; j++) {
            let value = cols[j].v;
            if (/1\.[0-9]+E[0-9]+/.test(value)) {
                value = new Date(Number(value) * 1000);
            }
            data[i][j] = value;
        }
    }

    Logger.log("Loaded %d rows", data.length);
    return data;
}

function runReport(statement, title, recipients) {
    // get "Reports" folder
    let folders = DriveApp.getRootFolder().getFolders();
    let reportsFolder = null;
    while (folders.hasNext()) {
        let folder = folders.next();
        if (folder.getName() == "Reports") {
            reportsFolder = folder;
            break;
        }
    }

    // process BigQuery job
    let headers = [];
    let data = bigquery(statement, headers);

    let spreadsheet = SpreadsheetApp.create(title);
    let sheet = spreadsheet.getActiveSheet();
    sheet.appendRow(headers);

    Logger.log("Loading rows into sheet");
    sheet.getRange(2, 1, data.length, headers.length).setValues(data);

    Logger.log('Results spreadsheet created: %s', spreadsheet.getUrl());

    var sheetFile = DriveApp.getFileById(spreadsheet.getId());
    sheetFile.moveTo(reportsFolder);

    Logger.log(`Sharing results with ${JSON.stringify(recipients)}`);
    recipients.forEach(email => {
        sheetFile.addEditor(email);
    });

    Logger.log("Report finished: %s", title);
}
