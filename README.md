# Now You're Cooking With GAS!
Google Apps Script modules for AWS, etc.

## Usage:

1. Create a new File > Script in your Google Apps Script project.
2. Use the base name of the script module you're interested in, e.g. "GasAWS" (this becomes `GasAWS.gs`).
3. Call the module's functions.

For example, after copying the contents of `GasAWS.js` to a new `GasAWS.gs` script file you can try running this:

```javascript
function TestGas() {
  AWS.init("access_key-id", "secret-access-key");
  let response = AWS.request('ec2', 'DescribeInstances', {"Version":"2015-10-01"});
  Logger.log(response);
}
```

Voila!
