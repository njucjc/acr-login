const core = require('@actions/core');

const ROAClient = require('@alicloud/pop-core').ROAClient;
const RPCClient = require('@alicloud/pop-core').RPCClient;
const { Docker } = require('@docker/actions-toolkit/lib/docker/docker');

const DEFAULT_REGISTRY_ENDPOINT = 'https://index.docker.io/v1/';

function getAPIEndpoint(regionId) {
    return `https://cr.${regionId}.aliyuncs.com`;
}

function getRegistryEndpoint(regionId) {
    return `https://registry.${regionId}.aliyuncs.com`;
}

function isBlank(str) {
    return !str || str.trim().length === 0;
}

async function getTempCredentialsWithROA({ accessKeyId, accessKeySecret, securityToken, endpoint }) {
    console.log('Getting tokens for temp user by access key ...');
    const client = new ROAClient({
        accessKeyId,
        accessKeySecret,
        securityToken,
        endpoint,
        apiVersion: '2016-06-07'
    });

    const result = await client.request('GET', '/tokens');
    return {
        username: result.data.tempUserName,
        password: result.data.authorizationToken
    };
}

async function getTempCredentialsWithRPC({ accessKeyId, accessKeySecret, securityToken, endpoint, instanceId, regionId }) {
    console.log(`Getting tokens for temp user by access key for instance ${instanceId} ...`);
    const client = new RPCClient({
        accessKeyId,
        accessKeySecret,
        securityToken,
        endpoint,
        codes: ['success'],
        apiVersion: '2018-12-01'
    });

    const result = await client.request('GetAuthorizationToken', {
        InstanceId: instanceId,
        RegionId: regionId
    });
    return {
        username: result.TempUsername,
        password: result.AuthorizationToken
    };
}

async function dockerLogin(username, password, loginServer) {
    const targetServer = isBlank(loginServer) ? DEFAULT_REGISTRY_ENDPOINT : loginServer;

    const res = await Docker.getExecOutput(
        ['login', '--password-stdin', '--username', username, targetServer],
        {
            ignoreReturnCode: true,
            silent: true,
            input: Buffer.from(password)
        }
    );

    if (res.stderr.length > 0 && res.exitCode !== 0) {
        throw new Error(res.stderr.trim());
    }

    core.info('Login Succeeded!');
}

async function run() {
    const accessKeyId = core.getInput('access-key-id', { required: false });
    const accessKeySecret = core.getInput('access-key-secret', { required: false });
    const securityToken = core.getInput('security-token', { required: false });
    const regionId = core.getInput('region-id', { required: false });
    const instanceId = core.getInput('instance-id', { required: false });
    const endpoint = core.getInput('endpoint', { required: false });

    let username = core.getInput('username', { required: false });
    let password = core.getInput('password', { required: false });
    let loginServer = core.getInput('login-server', { required: false });

    // If access key is provided, use it to get temporary credentials
    if (!isBlank(accessKeyId)) {
        if (isBlank(accessKeySecret)) {
            core.setFailed('Action failed: access-key-secret is required when access-key-id is provided');
            return;
        }

        if (isBlank(regionId)) {
            core.setFailed('Action failed: region-id is required when access-key-id is provided');
            return;
        }

        const apiEndpoint = isBlank(endpoint) ? getAPIEndpoint(regionId) : endpoint;

        try {
            let credentials;
            if (isBlank(instanceId)) {
                // Public ACR: use ROA client
                const registryEndpoint = isBlank(loginServer) ? getRegistryEndpoint(regionId) : loginServer;
                credentials = await getTempCredentialsWithROA({
                    accessKeyId,
                    accessKeySecret,
                    securityToken,
                    endpoint: apiEndpoint
                });
                loginServer = registryEndpoint;
            } else {
                // Enterprise ACR: use RPC client
                credentials = await getTempCredentialsWithRPC({
                    accessKeyId,
                    accessKeySecret,
                    securityToken,
                    endpoint: apiEndpoint,
                    instanceId,
                    regionId
                });
                // For enterprise instance, loginServer defaults to Docker Hub
            }

            username = credentials.username;
            password = credentials.password;
        } catch (err) {
            core.setFailed(`Action failed to get authorization token: ${err.message}`);
            return;
        }
    }

    // Validate credentials are available before attempting login
    if (isBlank(username) || isBlank(password)) {
        core.setFailed('Action failed: username and password are required. Provide them directly or via access-key-id/access-key-secret.');
        return;
    }

    try {
        await dockerLogin(username, password, loginServer);
    } catch (err) {
        core.setFailed(`Docker login failed: ${err.message}`);
    }
}

// Only run immediately if not in a test environment
if (process.env.NODE_ENV !== 'test') {
    run().catch(e => core.setFailed(e));
}

// Export functions for testing
module.exports = {
    getAPIEndpoint,
    getRegistryEndpoint,
    run
};
