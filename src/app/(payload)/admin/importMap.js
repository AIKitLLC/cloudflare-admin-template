import { AuditLogFilterBar as AuditLogFilterBar_ecd5fdade47073dc6b36a13ed313b628 } from '@/audit/admin/AuditLogFilterBar'
import { ClientSecurityNav as ClientSecurityNav_14c04150c87596a280850a65be41bbe2 } from '@/components/ClientSecurityNav'
import { PermissionMatrixNavLink as PermissionMatrixNavLink_296e6b50ca8aef8b2c24b9865dad8928 } from '../../../rbac/admin/PermissionMatrixNavLink'
import { JobsNavLink as JobsNavLink_23c78f3762a2ba85d5fca4b5af126301 } from '../../../jobs/admin/JobsNavLink'
import { ClientSecurityView as ClientSecurityView_5a0f26d3ec986850d6d6c0082eb8fe6d } from '@/components/ClientSecurityView'
import { PermissionMatrixView as PermissionMatrixView_a6b7e3134b67a22b5a78276aa2cacb4d } from '../../../rbac/admin/PermissionMatrixView'
import { JobsDashboardView as JobsDashboardView_493586ce3e5496796271cf7430c9dd4c } from '../../../jobs/admin/JobsDashboardView'
import { CollectionCards as CollectionCards_f9c02e79a4aed9a3924487c0cd4cafb1 } from '@payloadcms/next/rsc'
import { R2ClientUploadHandler as R2ClientUploadHandler_85cc02ed84006fcc91d3aff39dda669d } from '@payloadcms/storage-r2/client'

/** @type import('payload').ImportMap */
export const importMap = {
  "@/audit/admin/AuditLogFilterBar#AuditLogFilterBar": AuditLogFilterBar_ecd5fdade47073dc6b36a13ed313b628,
  "@/components/ClientSecurityNav#ClientSecurityNav": ClientSecurityNav_14c04150c87596a280850a65be41bbe2,
  "/rbac/admin/PermissionMatrixNavLink#PermissionMatrixNavLink": PermissionMatrixNavLink_296e6b50ca8aef8b2c24b9865dad8928,
  "/jobs/admin/JobsNavLink#JobsNavLink": JobsNavLink_23c78f3762a2ba85d5fca4b5af126301,
  "@/components/ClientSecurityView#ClientSecurityView": ClientSecurityView_5a0f26d3ec986850d6d6c0082eb8fe6d,
  "/rbac/admin/PermissionMatrixView#PermissionMatrixView": PermissionMatrixView_a6b7e3134b67a22b5a78276aa2cacb4d,
  "/jobs/admin/JobsDashboardView#JobsDashboardView": JobsDashboardView_493586ce3e5496796271cf7430c9dd4c,
  "@payloadcms/next/rsc#CollectionCards": CollectionCards_f9c02e79a4aed9a3924487c0cd4cafb1,
  "@payloadcms/storage-r2/client#R2ClientUploadHandler": R2ClientUploadHandler_85cc02ed84006fcc91d3aff39dda669d
}
