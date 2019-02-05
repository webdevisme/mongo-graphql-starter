import fs from "fs";
import path from "path";
import { TAB, TAB2 } from "./utilities";
import { MongoIdType, StringType, StringArrayType, MongoIdArrayType } from "../dataTypes";

import createItemTemplate from "./resolverTemplateMethods/createItem";
import updateItemTemplate from "./resolverTemplateMethods/updateItem";
import updateItemsTemplate from "./resolverTemplateMethods/updateItems";
import updateItemsBulkTemplate from "./resolverTemplateMethods/updateItemsBulk";

//fs.readFileSync(path.resolve(__dirname, "./resolverTemplateMethods/createItem.txt"), { encoding: "utf8" });

export default function createGraphqlResolver(objectToCreate, options) {
  let template = fs.readFileSync(path.resolve(__dirname, "./resolverTemplate.txt"), { encoding: "utf8" });
  let projectOneToOneResolverTemplate = fs.readFileSync(path.resolve(__dirname, "./projectOneToOneResolverTemplate.txt"), { encoding: "utf8" });
  let projectOneToManyResolverTemplate = fs.readFileSync(path.resolve(__dirname, "./projectOneToManyResolverTemplate.txt"), { encoding: "utf8" });
  let projectManyToManyResolverTemplate = fs.readFileSync(path.resolve(__dirname, "./projectManyToManyResolverTemplate.txt"), { encoding: "utf8" });

  let getItemTemplate = fs.readFileSync(path.resolve(__dirname, "./resolverTemplateMethods/getItem.txt"), { encoding: "utf8" });
  let allItemsTemplate = fs.readFileSync(path.resolve(__dirname, "./resolverTemplateMethods/allItems.txt"), { encoding: "utf8" });
  let deleteItemTemplate = fs.readFileSync(path.resolve(__dirname, "./resolverTemplateMethods/deleteItem.txt"), { encoding: "utf8" });
  let hooksPath = `"../hooks"`;
  let readonly = objectToCreate.readonly;

  let objName = objectToCreate.__name;
  let table = objectToCreate.table;

  if (options.hooks) {
    hooksPath = `"` + path.relative(options.modulePath, options.hooks).replace(/\\/g, "/") + `"`;
  }

  let result = "";
  let extras = objectToCreate.extras || {};
  let overrides = new Set(extras.overrides || []);
  let resolverSources = extras.resolverSources || [];
  let imports = [
    `import { insertUtilities, queryUtilities, projectUtilities, updateUtilities, processHook, dbHelpers, resolverHelpers } from "mongo-graphql-starter";`,
    `import hooksObj from ${hooksPath};`,
    `const { decontructGraphqlQuery, cleanUpResults } = queryUtilities;`,
    `const { setUpOneToManyRelationships, newObjectFromArgs } = insertUtilities;`,
    `const { getMongoProjection, parseRequestedFields } = projectUtilities;`,
    `const { getUpdateObject, setUpOneToManyRelationshipsForUpdate } = updateUtilities;`,
    `import { ObjectId } from "mongodb";`,
    `import ${objName}Metadata from "./${objName}";`,
    ...resolverSources.map(
      (src, i) =>
        `import ResolverExtras${i + 1} from "${src}";\nconst { Query: QueryExtras${i + 1}, Mutation: MutationExtras${i + 1}, ...OtherExtras${i +
          1} } = ResolverExtras${i + 1};`
    )
  ];

  let queryItems = [
    !overrides.has(`get${objName}`) ? getItemTemplate : "",
    !overrides.has(`all${objName}s`) ? allItemsTemplate : "",
    resolverSources.map((src, i) => `${TAB2}...(QueryExtras${i + 1} || {})`).join(",\n")
  ]
    .filter(s => s)
    .join(",\n");

  let typeExtras = resolverSources.map((src, i) => `${TAB2}...(OtherExtras${i + 1} || {})`).join(",\n");

  let deleteCleanups = [];
  Object.keys(objectToCreate.relationships).forEach(k => {
    let relationship = objectToCreate.relationships[k];
    if (relationship.fkField === "_id" && relationship.__isArray) {
      let asString = true;
      deleteCleanups.push(
        `resolverHelpers.cleanUpRelationshipArrayAfterDelete(
        $match._id, 
        hooksObj, 
        "${objName}", 
        { db, dbHelpers, table: "${relationship.type.table}", keyField: "${relationship.keyField}", asString: ${asString}, session: null },
        { root, args, context, ast }
      );`
      );
    }
  });

  let mutationItems = [
    ...(!readonly
      ? [
          !overrides.has(`create${objName}`) ? createItemTemplate({ objName }) : "",
          !overrides.has(`update${objName}`) ? updateItemTemplate({ objName, table }) : "",
          !overrides.has(`update${objName}s`) ? updateItemsTemplate({ objName, table }) : "",
          !overrides.has(`update${objName}sBulk`) ? updateItemsBulkTemplate({ objName, table }) : "",
          !overrides.has(`delete${objName}`) ? deleteItemTemplate.replace("${relationshipCleanup}", deleteCleanups.join("\n      ")) : ""
        ]
      : []),
    resolverSources.map((src, i) => `${TAB2}...(MutationExtras${i + 1} || {})`).join(",\n")
  ]
    .filter(s => s)
    .join(",\n");

  let typeImports = new Set([]);
  let relationshipResolvers = "";

  if (objectToCreate.relationships) {
    Object.keys(objectToCreate.relationships).forEach((relationshipName, index, all) => {
      let relationship = objectToCreate.relationships[relationshipName];

      if (!typeImports.has(relationship.type.__name)) {
        typeImports.add(relationship.type.__name);
        imports.push(`import { load${relationship.type.__name}s } from "../${relationship.type.__name}/resolver";`);
        imports.push(`import ${relationship.type.__name}Metadata from "../${relationship.type.__name}/${relationship.type.__name}";`);
      }

      if (!typeImports.has("flatMap")) {
        typeImports.add("flatMap");
        imports.push(`import flatMap from "lodash.flatmap";`);
      }

      if (!typeImports.has("dataloader")) {
        typeImports.add("dataloader");
        imports.push(`import DataLoader from "dataloader";`);
      }

      if (relationship.__isArray) {
        let template = relationship.manyToMany ? projectManyToManyResolverTemplate : projectOneToManyResolverTemplate;
        let destinationKeyType = relationship.type.fields[relationship.keyField];
        let foreignKeyType = objectToCreate.fields[relationship.fkField];
        let keyType = relationship.type.fields[relationship.keyField];

        let mapping = "";
        if (foreignKeyType == StringArrayType || foreignKeyType == MongoIdArrayType) {
          mapping = "ids => ids.map(id => X)";
        } else if (foreignKeyType == StringType || foreignKeyType == MongoIdType) {
          mapping = "id => X";
        }

        let lookupSetContents = /Array/g.test(keyType)
          ? `result.${relationship.keyField}.map(k => k + "")`
          : `[result.${relationship.keyField} + ""]`;

        if (mapping) {
          if (destinationKeyType == MongoIdType || destinationKeyType == MongoIdArrayType) {
            mapping = mapping.replace(/X/i, "ObjectId(id)");
          } else if (destinationKeyType == StringType || destinationKeyType == StringArrayType) {
            mapping = mapping.replace(/X/i, `"" + id`);
          }
        } else {
          mapping = "x => x";
        }

        relationshipResolvers += template
          .replace(/\${table}/g, relationship.type.table)
          .replace(/\${fkField}/g, relationship.fkField)
          .replace(/\${keyField}/g, relationship.keyField || "_id")
          .replace(/\${idMapping}/g, mapping)
          .replace(/\${targetObjName}/g, relationshipName)
          .replace(/\${targetTypeName}/g, relationship.type.__name)
          .replace(/\${targetTypeNameLower}/g, relationship.type.__name.toLowerCase())
          .replace(/\${sourceParam}/g, objName.toLowerCase())
          .replace(/\${sourceObjName}/g, objName)
          .replace(/\${dataLoaderId}/g, `__${objName}_${relationshipName}DataLoader`)
          .replace(/\${lookupSetContents}/g, lookupSetContents)
          .replace(
            /\${receivingKeyForce}/g,
            relationship.keyField && relationship.keyField != "_id" ? `, { force: ["${relationship.keyField}"] }` : ""
          );
      } else if (relationship.__isObject) {
        relationshipResolvers += projectOneToOneResolverTemplate
          .replace(/\${table}/g, relationship.type.table)
          .replace(/\${fkField}/g, relationship.fkField)
          .replace(/\${keyField}/g, relationship.keyField || "_id")
          .replace(/\${idMapping}/g, relationship.type.fields[relationship.keyField || "_id"] === MongoIdType ? "id => ObjectId(id)" : "id => id")
          .replace(/\${targetObjName}/g, relationshipName)
          .replace(/\${targetTypeName}/g, relationship.type.__name)
          .replace(/\${targetTypeNameLower}/g, relationship.type.__name.toLowerCase())
          .replace(/\${sourceParam}/g, objName.toLowerCase())
          .replace(/\${sourceObjName}/g, objName)
          .replace(/\${dataLoaderId}/g, `__${objName}_${relationshipName}DataLoader`)
          .replace(
            /\${receivingKeyForce}/g,
            relationship.keyField && relationship.keyField != "_id" ? `, { force: ["${relationship.keyField}"] }` : ""
          );
      }

      if (index < all.length - 1) {
        relationshipResolvers += ",\n";
      }
    });
  }

  result += template
    .replace(/\${queryItems}/g, queryItems)
    .replace(/\${typeExtras}/g, typeExtras)
    .replace(/\${mutationItems}/g, mutationItems)
    .replace(/\${relationshipResolvers}/g, relationshipResolvers)
    .replace(/\${table}/g, objectToCreate.table)
    .replace(/\${objName}/g, objName)
    .replace(/\${objNameLower}/g, objName.toLowerCase());

  return `
${imports.join("\n")}

${result}`.trim();
}
