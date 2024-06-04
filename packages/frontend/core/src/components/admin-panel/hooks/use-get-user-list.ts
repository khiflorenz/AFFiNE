import { useQuery } from '@affine/core/hooks/use-query';
import { getUserListQuery } from '@affine/graphql';

export const useGetUserList = (skip: number, first: number = 8) => {
  const { data } = useQuery({
    query: getUserListQuery,
    variables: {
      filter: {
        skip,
        first,
      },
    },
  });

  return data.users || [];
};
