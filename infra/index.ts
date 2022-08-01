import * as aws from '@pulumi/aws';
import * as eks from '@pulumi/eks';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import S3ServiceAccount from './S3ServiceAccount';
import TraefikRoute from './TraefikRoute';

// Create a Kubernetes cluster.
const cluster = new eks.Cluster('mlops-eks', {
  createOidcProvider: true,
});


// Install Traefik
const traefik = new k8s.helm.v3.Chart('traefik', {
  chart: 'traefik',
  fetchOpts: { repo: 'https://helm.traefik.io/traefik' },
}, { provider: cluster.provider })



// Create PostgreSQL database for MLFlow - this will save model metadata
const dbPassword = new random.RandomPassword('mlops-db-password', { length: 16, special: false });
const db = new aws.rds.Instance('mlflow-db', {
  allocatedStorage: 10,
  engine: "postgres",
  engineVersion: "14.1",
  instanceClass: "db.t3.micro",
  name: "mlflow",
  password: dbPassword.result,
  skipFinalSnapshot: true,
  vpcSecurityGroupIds: [cluster.clusterSecurityGroup.id, cluster.nodeSecurityGroup.id],
  username: "postgres",
});


// Create S3 bucket for MLFlow
const mlflowBucket = new aws.s3.Bucket("mlflow-bucket", {
  acl: "public-read-write",
});


// Create S3 bucket for DVC
const dvcBucket = new aws.s3.Bucket("dvc-bucket", {
  acl: "public-read-write",
});


// Install MLFlow
const mlflowNamespace = new k8s.core.v1.Namespace('mlflow-namespace', {
  metadata: { name: 'mlflow' },
}, { provider: cluster.provider });

const mlflowServiceAccount = new S3ServiceAccount('mlflow-service-account', {
  namespace: mlflowNamespace.metadata.name,
  oidcProvider: cluster.core.oidcProvider!,
  readOnly: false,
}, { provider: cluster.provider });

const mlflow = new k8s.helm.v3.Chart("mlflow", {
  chart: "mlflow",
  namespace: mlflowNamespace.metadata.name,
  values: {
    "backendStore": {
      "postgres": {
        "username": db.username,
        "password": db.password,
        "host": db.address,
        "port": db.port,
        "database": "mlflow"
      }
    },
    "defaultArtifactRoot": mlflowBucket.bucket.apply((bucketName: string) => `s3://${bucketName}`),
    "serviceAccount": {
      "create": false,
      "name": mlflowServiceAccount.name,
    }
  },
  fetchOpts: { repo: "https://larribas.me/helm-charts" },
}, { provider: cluster.provider });


// Expose MLFlow in Traefik as /mlflow 
new TraefikRoute('mlflow', {
  prefix: '/mlflow',
  service: mlflow.getResource('v1/Service', 'mlflow', 'mlflow'),
  namespace: mlflowNamespace.metadata.name,
}, { provider: cluster.provider, dependsOn: [mlflow] });


// Service account for models with read only access to models
const modelsServiceAccount = new S3ServiceAccount('models-service-account', {
  namespace: 'default',
  oidcProvider: cluster.core.oidcProvider!,
  readOnly: true,
}, { provider: cluster.provider });


// Set http://mlops.jaganlal.com DNS record in Route53
// zoneId: process.env["ROUTE_ZONE_ID"] as string
new aws.route53.Record("record", {
  zoneId: "Z050993537OA9IQ27P3LT",
  name: "www",
  type: "CNAME",
  ttl: 300,
  records: [traefik.getResource('v1/Service', 'traefik').status.loadBalancer.ingress[0].hostname],
});

// const selected = aws.route53.getZone({
//   name: "mlops.jaganlal.com",
//   privateZone: true,
// });
// const www = new aws.route53.Record("www", {
//   zoneId: selected.then(selected => selected.zoneId),
//   name: selected.then(selected => `www.${selected.name}`),
//   type: "A",
//   ttl: 300,
//   records: [traefik.getResource('v1/Service', 'traefik').status.loadBalancer.ingress[0].hostname],
// });


export const kubeconfig = cluster.kubeconfig;
export const mlflowTrackingURI = `http://www.mlopsinfra.com/mlflow`;
export const dvcBucketURI = dvcBucket.bucket.apply((bucketName: string) => `s3://${bucketName}`);
export const modelsServiceAccountName = modelsServiceAccount.name;