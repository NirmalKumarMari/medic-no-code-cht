"""Disable edge caching on preview API responses, scoped to the preview path."""
import copy
import boto3

cf=boto3.client('cloudfront')
domain='d3kk07plry56g2.cloudfront.net'
distribution=next(item for page in cf.get_paginator('list_distributions').paginate()
                  for item in page['DistributionList'].get('Items',[]) if item['DomainName']==domain)
identifier=distribution['Id']
current=cf.get_distribution_config(Id=identifier)
config=current['DistributionConfig']
behaviors=config.setdefault('CacheBehaviors',{'Quantity':0}).get('Items',[])
path='/vera-preview/api/*'
if not any(b['PathPattern']==path for b in behaviors):
    policy=next(item['CachePolicy']['Id'] for item in cf.list_cache_policies(Type='managed')['CachePolicyList']['Items']
                if item['CachePolicy']['CachePolicyConfig']['Name']=='Managed-CachingDisabled')
    preview=copy.deepcopy(config['DefaultCacheBehavior'])
    preview.update(PathPattern=path, CachePolicyId=policy)
    config['CacheBehaviors']={'Quantity':len(behaviors)+1,'Items':[preview,*behaviors]}
    cf.update_distribution(Id=identifier,IfMatch=current['ETag'],DistributionConfig=config)
print('Preview API cache behavior configured')
