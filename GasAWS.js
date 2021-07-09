/*
 * Google Apps Script wrapper for AWS API by Neil C. Obremski circa Summer 2021
 * (Based on https://github.com/losthismind/aws-apps-scripts)
 * 
 * Usage:
 * 
 * AWS.init("access-key-id", "secret-access-key");
 * AWS.request('ec2', 'DescribeInstances', {"Version":"2015-10-01"});
 * 
 * Request Parameters:
 * 
 * 1. service (REQUIRED): API service as it appears in host name.
 * 2. action (REQUIRED): API action.
 * 3. params (OPTIONAL): API parameters.
 * 4. region (OPTIONAL): AWS region defaults to AWS_DEFAULT_REGION const.
 * 5. method (OPTIONAL): HTTP method; defaults to "GET".
 * 6. payload (OPTIONAL): Request body; converted to JSON string if object.
 * 7. headers (OPTIONAL): HTTP headers to send; this is updated with auth headers, etc.
 * 8. uri (OPTIONAL): Request path defaults to "/".
 * 9. bucket (OPTIONAL): S3 bucket name defaults to AWS_DEFAULT_BUCKET const.
 * 
 * Notes:
 * 
 * Always pay attention to the "Version" parameter! To see what AWS CLI is sending:
 * 
 * aws --debug ec2 describe-instances 2>&1 | grep Version
 * 
 * References:
 * 
 * https://docs.aws.amazon.com/general/latest/gr/Welcome.html
 */
const AWS_DEFAULT_BUCKET = "DefaultS3Bucket";
const AWS_DEFAULT_REGION = "us-east-1";

const AWS = (function (){

  // closure-protected variables can be set but not retrieved; see Init()
  let accessKey;
  let secretKey;

  function BuildAndSendRequest(service, action, params, region, method, payload, headers, uri, bucket) {
    return SendRequest(BuildRequest(service, action, params, region, method, payload, headers, uri, bucket));
  }

  function BytesToHex(bytes) {
    // convert byte[] to string of hex characters
    let hex = [];
    for (let i = 0; i < bytes.length; i++) {
      let b = parseInt(bytes[i]);
      if (b < 0) {
        c = (256+b).toString(16);
      } else {
        c = b.toString(16);
      }
      if (c.length == 1) {
        hex.push("0" + c);
      } else {
        hex.push(c);
      }
    }
    return hex.join("");
  }

  function Sha256Hash(value) {
    // compute SHA-256 hash/digest and output as string of hex characters
    return BytesToHex(
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256, value));
  }

  function Sha256Hmac(value, key) {
    // compute SHA-256 HMAC signature and output as a string of hex characters
    return BytesToHex(Utilities.computeHmacSha256Signature(Utilities.newBlob(value).getBytes(), key));
  }

  function GetSignatureKey(key, dateStamp, regionName, serviceName) {
    // compute signing key for AWS REST API
    // https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
    const kDate = Utilities.computeHmacSha256Signature(dateStamp, "AWS4" + key);
    const kRegion = Utilities.computeHmacSha256Signature(Utilities.newBlob(regionName).getBytes(), kDate);
    const kService = Utilities.computeHmacSha256Signature(Utilities.newBlob(serviceName).getBytes(), kRegion);
    const kSigning = Utilities.computeHmacSha256Signature(Utilities.newBlob("aws4_request").getBytes(), kService);
    return kSigning;
  }

  function Init(access_key, secret_key) {
    // set protected access key ID and secret properties within closure
    accessKey = access_key;
    secretKey = secret_key;
  }

  function BuildRequest(service, action, params, region, method, payload, headers, uri, bucket) {
    // generates request data including signature for calling REST API

    // parameter validation / defaults
    if (!service) {
      throw Error("Missing AWS API Service");
    }
    if (!action) {
      throw Error("Missing AWS API Action");
    }
    region = region || AWS_DEFAULT_REGION;
    method = method || "GET";
    payload = payload || '';
    uri = uri || "/";
    bucket = bucket || AWS_DEFAULT_BUCKET;

    // convert payload to JSON string if not already a string
    if(typeof(payload) !== "string") {
      payload = JSON.stringify(payload);
    }

    const dateTimeStamp = Utilities.formatDate(new Date(), "GMT", "yyyyMMdd'T'HHmmss'Z'");
    const dateStamp = dateTimeStamp.substring(0, 8);
    const hashedPayload = Sha256Hash(payload);

    const host = GetHost(service, region, bucket);
    headers = headers || {};
    let url;
    let query = '';
    if (method.toLowerCase() == "post") {
      url = `https://${host}${uri}`;
    } else {
      query = `Action=${action}`;
      if(params) {
        Object.keys(params).sort(function(a,b) { return a<b?-1:1; }).forEach(function(name) {
          query += `&${name}=${UrlEncode(params[name])}`;
        });
      }
      url = `https://${host}${uri}?${query}`;
    }

    // initialize headers and sign
    headers["Host"] = host;
    headers["X-Amz-Date"] = dateTimeStamp;
    headers["X-Amz-Target"] = action;
    headers["X-Amz-Content-SHA256"] = hashedPayload;
    let canonHeaders = "";
    let signedHeaders = "";
    Object.keys(headers).sort(function(a,b){return a<b?-1:1;}).forEach(function(h) {
      canonHeaders += h.toLowerCase() + ":" + headers[h] + "\n";
      signedHeaders += h.toLowerCase() + ";";
    });
    signedHeaders = signedHeaders.substring(0, signedHeaders.length-1);

    const CanonicalString = `${method}\n${uri}\n${query}\n${canonHeaders}\n${signedHeaders}\n${hashedPayload}`;
    const canonHash = Sha256Hash(CanonicalString);
    const algorithm = "AWS4-HMAC-SHA256";
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const StringToSign = `${algorithm}\n${dateTimeStamp}\n${scope}\n${canonHash}`;
    const key = GetSignatureKey(secretKey, dateStamp, region, service);
    const signature = Sha256Hmac(StringToSign, key);
    const authHeader = `${algorithm} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders},Signature=${signature}`;

    headers["Authorization"] = authHeader;
    delete headers["Host"];

    let requestObject = {
      url: url,
      method: method,
      headers: headers,
      muteHttpExceptions: true,
      payload: payload,
    };

    Logger.log("Generated AWS API request");
    Logger.log(requestObject);
    return requestObject;
  }

  function SendRequest(request) {
    // call API using request built by Request()
    return UrlFetchApp.fetchAll([request])[0];
  }

  function UrlEncode(str) {
    // string URL encoding of characters that JavaScript otherwise leaves unencoded
    return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
      return '%' + c.charCodeAt(0).toString(16);
    });
  }

  function GetHost(service, region, bucket) {
    // get host name destination of AWS request
    // (S3 includes bucket name in host but no region)
    return [
      (service == "s3" ? bucket : undefined),
      service,
      (service == "s3" ? undefined : region),
      "amazonaws.com"
    ].filter(Boolean).join(".");
  }

  // generate interface object for caller
  return {
    init: Init,
    request: BuildAndSendRequest,
    getSignatureKey: GetSignatureKey,
    bytesToHex: BytesToHex,
  };

})();

function TestAWS() {
  Logger.log("Testing AWS getSignatureKey()");
  const key = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  const dateStamp = '20120215'
  const regionName = 'us-east-1'
  const serviceName = 'iam'
  const expectedSigKey = 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d';
  const sigKey = AWS.bytesToHex(AWS.getSignatureKey(key, dateStamp, regionName, serviceName));
  Logger.log(`Expect: ${expectedSigKey}`);
  Logger.log(`Actual: ${sigKey}`);
  if (sigKey != expectedSigKey) {
    throw Error("AWS signature key test failed");
  }
}
