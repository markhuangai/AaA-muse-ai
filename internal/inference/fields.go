package inference

import (
	"reflect"
	"strings"
)

func exactFields(value any, kind reflect.Type) error {
	if kind == nil {
		return nil
	}
	for kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	switch kind.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		fields := map[string]reflect.Type{}
		structFields(kind, fields)
		for key, child := range object {
			childType, ok := fields[key]
			if !ok {
				return Reject("unsupported_field_spelling", 400, "field", key)
			}
			if err := exactFields(child, childType); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		if items, ok := value.([]any); ok {
			for _, item := range items {
				if err := exactFields(item, kind.Elem()); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func structFields(kind reflect.Type, fields map[string]reflect.Type) {
	for i := 0; i < kind.NumField(); i++ {
		field := kind.Field(i)
		if field.PkgPath != "" {
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if field.Anonymous && name == "" {
			structFields(field.Type, fields)
			continue
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = field.Type
	}
}
